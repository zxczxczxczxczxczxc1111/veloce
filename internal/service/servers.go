package service

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/crypto/ssh"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/store"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

type ConnRegistry struct {
	mu    sync.RWMutex
	conns map[string]transport.Conn
}

func NewConnRegistry() *ConnRegistry {
	return &ConnRegistry{conns: map[string]transport.Conn{}}
}

func (r *ConnRegistry) Get(serverID string) (transport.Conn, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.conns[serverID]
	if !ok {
		return nil, fmt.Errorf("нет соединения с сервером %s", serverID)
	}
	return c, nil
}

func (r *ConnRegistry) Set(serverID string, c transport.Conn) {
	r.mu.Lock()
	if old, ok := r.conns[serverID]; ok {
		old.Close()
	}
	r.conns[serverID] = c
	r.mu.Unlock()
}

// ConnStateEvent летит на фронт при каждой смене состояния. Poll со стороны
// интерфейса не нужен.
type ConnStateEvent struct {
	ServerID    string `json:"serverId"`
	State       string `json:"state"`
	Fingerprint string `json:"fingerprint,omitempty"`
	// KnownFingerprint заполнен только у hostKeyChanged: это тот отпечаток,
	// который лежит в known_hosts. Показывать смену ключа одним новым
	// значением бессмысленно, сравнивать не с чем.
	KnownFingerprint string `json:"knownFingerprint,omitempty"`
	Message          string `json:"message,omitempty"`
}

type ServersService struct {
	app   *application.App
	st    *store.Store
	conns *ConnRegistry
}

func NewServersService(app *application.App, st *store.Store, conns *ConnRegistry) *ServersService {
	return &ServersService{app: app, st: st, conns: conns}
}

func (s *ServersService) List() []store.Server        { return s.st.List() }
func (s *ServersService) Save(srv store.Server) error { return s.st.Put(srv) }
func (s *ServersService) Delete(id string) error      { return s.st.Delete(id) }

// Connect подключается и сообщает результат событием. Ошибки разделены по
// смыслу: неизвестный ключ хоста требует решения пользователя, отказ
// аутентификации требует правки настроек, отказ бастиона указывает на другое
// звено. Общего «не удалось подключиться» здесь быть не должно.
func (s *ServersService) Connect(id string) error {
	srv, ok := s.st.Get(id)
	if !ok {
		return fmt.Errorf("сервер %s не найден", id)
	}

	s.app.Event.Emit("conn:state", ConnStateEvent{ServerID: id, State: "connecting"})

	cfg, err := s.configFor(srv)
	if err != nil {
		return err
	}

	hk, err := transport.KnownHosts()
	if err != nil {
		return err
	}

	conn, err := transport.Dial(context.Background(), cfg, hk)
	if err != nil {
		var unknown *transport.ErrHostKeyUnknown
		if errors.As(err, &unknown) {
			s.app.Event.Emit("conn:state", ConnStateEvent{
				ServerID: id, State: "hostKeyUnknown", Fingerprint: unknown.Fingerprint,
			})
			return nil
		}
		// Сменившийся ключ едет со ВТОРЫМ отпечатком: без сохранённого
		// человеку нечего сравнивать, а решать здесь ему.
		var changed *transport.ErrHostKeyChanged
		if errors.As(err, &changed) {
			s.app.Event.Emit("conn:state", ConnStateEvent{
				ServerID: id, State: "hostKeyChanged",
				Fingerprint: changed.Fingerprint, KnownFingerprint: changed.Known,
			})
			return nil
		}
		// Вид отказа разбирается тем же разбором, что и при переподключении.
		// Общее «не удалось подключиться» здесь запрещено спекой раздела 10:
		// «ключ не принят» и «лёг бастион» чинятся совершенно по-разному.
		s.app.Event.Emit("conn:state", ConnStateEvent{
			ServerID: id, State: stateName(transport.StateForError(err)),
			Message: err.Error(),
		})
		return err
	}

	// Хук вешаем ДО того, как соединение попадёт в реестр: с этого момента
	// любая смена состояния внутри транспорта уезжает в интерфейс сама, и
	// разрыв больше не выглядит как «цифры почему-то замерли».
	conn.SetStateHook(func(st transport.State) {
		s.app.Event.Emit("conn:state", ConnStateEvent{
			ServerID: id, State: stateName(st),
		})
	})

	s.conns.Set(id, conn)
	s.app.Event.Emit("conn:state", ConnStateEvent{ServerID: id, State: "connected"})
	return nil
}

// stateName переводит состояние транспорта в строку для интерфейса. Значения
// перечислены явно, а не через Stringer: фронт разбирает их switch-ем, и
// молчаливое появление нового значения там сломало бы отображение.
func stateName(st transport.State) string {
	switch st {
	case transport.StateConnecting:
		return "connecting"
	case transport.StateConnected:
		return "connected"
	case transport.StateAuthFailed:
		return "authFailed"
	case transport.StateHostKeyUnknown:
		return "hostKeyUnknown"
	case transport.StateHostKeyChanged:
		return "hostKeyChanged"
	case transport.StateJumpFailed:
		return "jumpFailed"
	default:
		return "disconnected"
	}
}

// TrustHost вызывается ТОЛЬКО после того, как пользователь увидел отпечаток и
// нажал согласие.
//
// Параметр fingerprint обязателен и сверяется. Без сверки здесь открывается
// окно для подмены: пользователь подтвердил один ключ, а второе соединение
// принесло бы другой, и мы записали бы в known_hosts ключ атакующего с полного
// согласия человека, который согласия на него не давал. Диалог с отпечатком
// без этой проверки был бы театром.
func (s *ServersService) TrustHost(id, fingerprint string) error {
	if fingerprint == "" {
		return fmt.Errorf("отпечаток не передан")
	}
	srv, ok := s.st.Get(id)
	if !ok {
		return fmt.Errorf("сервер %s не найден", id)
	}

	var seen ssh.PublicKey
	grab := func(hostport string, key ssh.PublicKey) error {
		// Сверяем прямо здесь, в момент рукопожатия: соединение с чужим ключом
		// не должно состояться вообще, а не «состояться и быть отброшенным».
		if got := ssh.FingerprintSHA256(key); got != fingerprint {
			return fmt.Errorf("ключ хоста изменился между показом и подтверждением: показывали %s, пришёл %s",
				fingerprint, got)
		}
		seen = key
		return nil
	}

	// Бастион здесь обязателен ровно так же, как в Connect: без него сервер за
	// бастионом невозможно подтвердить, а значит и подключить вообще.
	cfg, err := s.configFor(srv)
	if err != nil {
		return err
	}

	conn, err := transport.Dial(context.Background(), cfg, grab)
	if err != nil {
		return err
	}
	conn.Close()

	if seen == nil {
		return fmt.Errorf("не удалось получить ключ хоста")
	}
	hostport := transport.HostPort(srv.Host, srv.Port)
	if err := transport.AppendKnownHost(hostport, seen); err != nil {
		return err
	}
	return s.Connect(id)
}

// Fingerprint отдаёт сохранённый отпечаток хоста или пустую строку, если хост
// ещё не подтверждён. Читает known_hosts, своей копии отпечатков приложение не
// заводит: два источника правды разъедутся в первый же день.
func (s *ServersService) Fingerprint(id string) (string, error) {
	srv, ok := s.st.Get(id)
	if !ok {
		return "", fmt.Errorf("сервер %s не найден", id)
	}
	return transport.KnownHostFingerprint(transport.HostPort(srv.Host, srv.Port))
}

// ForgetHost убирает запись из known_hosts. Нужен, когда сервер пересоздали и
// ключ сменился законно: без этого пользователь идёт править файл руками.
func (s *ServersService) ForgetHost(id string) error {
	srv, ok := s.st.Get(id)
	if !ok {
		return fmt.Errorf("сервер %s не найден", id)
	}
	return transport.RemoveKnownHost(transport.HostPort(srv.Host, srv.Port))
}

// configFor собирает конфиг подключения вместе с бастионом. Вынесено отдельно,
// потому что нужно и Connect, и TrustHost: раньше ветка бастиона жила только в
// Connect, и подтвердить ключ сервера за бастионом было нельзя.
func (s *ServersService) configFor(srv store.Server) (transport.Config, error) {
	cfg := toTransportConfig(srv)
	if srv.JumpVia == "" {
		return cfg, nil
	}
	jump, ok := s.st.Get(srv.JumpVia)
	if !ok {
		return transport.Config{}, fmt.Errorf("бастион %s не найден", srv.JumpVia)
	}
	jc := toTransportConfig(jump)
	cfg.JumpVia = &jc
	return cfg, nil
}

func toTransportConfig(s store.Server) transport.Config {
	return transport.Config{
		Host: s.Host, Port: s.Port, User: s.User,
		KeyPath: s.KeyPath, UseAgent: s.UseAgent,
	}
}
