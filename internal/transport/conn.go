package transport

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// redialFunc поднимает новое соединение теми же настройками и возвращает пару
// «цель, бастион» (второй nil при прямом подключении). Хранится внутри conn,
// чтобы переподключение не требовало тащить сюда знание о хранилище.
type redialFunc func(ctx context.Context) (target, bastion *ssh.Client, err error)

type conn struct {
	mu sync.RWMutex
	// redialMu отдельно от mu и держится всё время переподключения. Через одно
	// соединение конкурентно ходят метрики (такт 2с), проекты и логи: без этого
	// мьютекса двое одновременно проходят проверку состояния, оба поднимают по
	// SSH-клиенту, в c.client попадает последний, а первый не закрывается
	// никогда. На флапающей сети это копится живыми сессиями на сервере.
	redialMu sync.Mutex

	client *ssh.Client
	// bastion - клиент бастиона, через который поднят client. Хранится, чтобы
	// закрыть его вместе с целью: иначе каждое переподключение оставляло бы
	// живое соединение с бастионом.
	bastion *ssh.Client

	cfg     Config
	hk      HostKeyPolicy
	state   State
	redial  redialFunc
	backoff time.Duration
	onState func(State)
	closed  bool
}

func newConn(cl, bastion *ssh.Client, cfg Config, hk HostKeyPolicy, rd redialFunc) Conn {
	return &conn{client: cl, bastion: bastion, cfg: cfg, hk: hk,
		state: StateConnected, redial: rd}
}

// SetStateHook нужен слою сервисов, чтобы слать событие в интерфейс на каждой
// смене состояния. Без него интерфейс узнавал бы о разрыве только по тому, что
// цифры перестали меняться, а это неотличимо от спокойного сервера.
func (c *conn) SetStateHook(f func(State)) {
	c.mu.Lock()
	c.onState = f
	c.mu.Unlock()
}

func (c *conn) State() State {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state
}

func (c *conn) setState(s State) {
	c.mu.Lock()
	if c.state == s {
		c.mu.Unlock()
		return
	}
	c.state = s
	hook := c.onState
	c.mu.Unlock()
	if hook != nil {
		hook(s)
	}
}

// StateForError переводит ошибку подключения в состояние. Без него
// StateAuthFailed и StateJumpFailed не выставлялись бы нигде, а ветка в ensure,
// которая прекращает бессмысленные попытки при неверном ключе, была бы
// недостижима: панель переподключалась бы вечно с паузой 30 секунд.
//
// Экспортирована ради слоя сервисов: первое подключение падает до того, как
// повешен хук состояния, и без общего разбора Connect отдавал бы наверх одно
// «не удалось» на все причины сразу.
func StateForError(err error) State {
	var changed *ErrHostKeyChanged
	if errors.As(err, &changed) {
		return StateHostKeyChanged
	}
	var unknown *ErrHostKeyUnknown
	if errors.As(err, &unknown) {
		return StateHostKeyUnknown
	}
	switch {
	case errors.Is(err, ErrJumpFailed):
		return StateJumpFailed
	case isAuthError(err):
		return StateAuthFailed
	default:
		return StateDisconnected
	}
}

// isAuthError опознаёт отказ аутентификации. Типизированной ошибки у
// golang.org/x/crypto/ssh для этого нет, поэтому смотрим на текст - другого
// способа библиотека не даёт.
func isAuthError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "unable to authenticate") ||
		strings.Contains(msg, "no supported methods remain") ||
		strings.Contains(msg, "парольной фразой") ||
		strings.Contains(msg, "не указан ни ключ, ни агент")
}

// Пауза между попытками: 1, 2, 4, 8, 16, 30 и дальше 30 секунд. Чаще долбиться
// в упавший сервер бессмысленно и злит fail2ban на той стороне, реже -
// пользователь успеет решить, что сломалось приложение.
const (
	backoffStart = 1 * time.Second
	backoffMax   = 30 * time.Second
)

// ensure возвращает живого клиента, при необходимости переподключаясь.
// Вызывается перед КАЖДОЙ командой: соединение могло умереть в любой момент
// между двумя тактами метрик, и узнать об этом заранее нельзя.
func (c *conn) ensure(ctx context.Context) (*ssh.Client, error) {
	if cl, ok := c.live(); ok {
		return cl, nil
	}

	// Переподключается ровно один вызывающий, остальные ждут его на мьютексе.
	c.redialMu.Lock()
	defer c.redialMu.Unlock()

	// Повторная проверка под мьютексом: пока мы ждали, кто-то уже мог всё
	// поднять, и второе соединение было бы лишним.
	if cl, ok := c.live(); ok {
		return cl, nil
	}

	c.mu.RLock()
	closed, st := c.closed, c.state
	c.mu.RUnlock()
	if closed {
		return nil, io.ErrClosedPipe
	}
	// Отказ аутентификации и неизвестный ключ переподключением не лечатся:
	// ключ не станет верным от повторной попытки, а долбёжка только разозлит
	// fail2ban. Здесь нужен человек, а не цикл.
	if st == StateAuthFailed || st == StateHostKeyUnknown || st == StateHostKeyChanged {
		return nil, io.ErrClosedPipe
	}

	c.setState(StateConnecting)

	c.mu.Lock()
	if c.backoff == 0 {
		c.backoff = backoffStart
	}
	wait := c.backoff
	c.mu.Unlock()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(wait):
	}

	target, bastion, err := c.redial(ctx)
	if err != nil {
		c.mu.Lock()
		c.backoff *= 2
		if c.backoff > backoffMax {
			c.backoff = backoffMax
		}
		c.mu.Unlock()
		c.setState(StateForError(err))
		return nil, err
	}

	c.mu.Lock()
	oldBastion := c.bastion
	c.client, c.bastion = target, bastion
	c.backoff = backoffStart
	c.mu.Unlock()

	// Старый бастион закрываем ПОСЛЕ подмены: он больше никому не нужен, а
	// оставленный живым копился бы по одному на каждое переподключение.
	if oldBastion != nil {
		oldBastion.Close()
	}

	c.setState(StateConnected)
	return target, nil
}

func (c *conn) live() (*ssh.Client, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.closed {
		return nil, false
	}
	return c.client, c.client != nil && c.state == StateConnected
}

func (c *conn) Run(ctx context.Context, cmd string) (Result, error) {
	cl, err := c.ensure(ctx)
	if err != nil {
		return Result{}, err
	}

	sess, err := cl.NewSession()
	if err != nil {
		c.setState(StateDisconnected)
		return Result{}, err
	}
	defer sess.Close()

	var out, errb bytes.Buffer
	sess.Stdout = &out
	sess.Stderr = &errb

	done := make(chan error, 1)
	go func() { done <- sess.Run(cmd) }()

	select {
	case <-ctx.Done():
		sess.Signal(ssh.SIGKILL)
		return Result{}, ctx.Err()
	case err := <-done:
		res := Result{Stdout: out.String(), Stderr: errb.String()}
		if err == nil {
			return res, nil
		}
		// Ненулевой код возврата это ответ сервера, а не сбой связи.
		var ee *ssh.ExitError
		if ok := asExitError(err, &ee); ok {
			res.Code = ee.ExitStatus()
			return res, nil
		}
		c.setState(StateDisconnected)
		return res, err
	}
}

// Stream отдаёт stdout долгоживущей команды. Закрытие ReadCloser убивает сессию,
// иначе `docker logs -f` остаётся висеть на сервере после ухода с экрана.
func (c *conn) Stream(ctx context.Context, cmd string) (io.ReadCloser, error) {
	cl, err := c.ensure(ctx)
	if err != nil {
		return nil, err
	}

	sess, err := cl.NewSession()
	if err != nil {
		return nil, err
	}
	pipe, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	if err := sess.Start(cmd); err != nil {
		sess.Close()
		return nil, err
	}

	go func() {
		<-ctx.Done()
		sess.Signal(ssh.SIGKILL)
		sess.Close()
	}()

	return &sessionReader{r: pipe, sess: sess}, nil
}

type sessionReader struct {
	r    io.Reader
	sess *ssh.Session
}

func (s *sessionReader) Read(p []byte) (int, error) { return s.r.Read(p) }
func (s *sessionReader) Close() error               { return s.sess.Close() }

// Close закрывает соединение окончательно. Флаг closed отличает «пользователь
// ушёл» от «сеть моргнула»: без него ensure бодро переподключался бы к серверу,
// который закрыли намеренно.
func (c *conn) Close() error {
	c.mu.Lock()
	c.closed = true
	c.state = StateDisconnected
	cl, bastion := c.client, c.bastion
	c.client, c.bastion = nil, nil
	c.mu.Unlock()

	// Бастион закрывается тоже. Раньше наверх уходил только клиент цели, и
	// соединение с бастионом жило до конца процесса.
	if bastion != nil {
		bastion.Close()
	}
	if cl == nil {
		return nil
	}
	return cl.Close()
}

func asExitError(err error, target **ssh.ExitError) bool {
	return errors.As(err, target)
}
