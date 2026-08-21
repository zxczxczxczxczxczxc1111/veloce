package transport

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// Канал агента OpenSSH на Windows. Это единственный поддерживаемый агент:
// Pageant говорит по другому протоколу и ради него заводить вторую ветку кода
// не будем.
//
// ДВЕ обратных косых в начале обязательны, это формат именованного канала
// Windows. С одной DialPipe не найдёт агент никогда, и галочка «Агент
// OpenSSH» отвечает «агент недоступен» даже на живой службе.
const agentPipe = `\\.\pipe\openssh-ssh-agent`

func authMethods(cfg Config) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod

	if cfg.UseAgent {
		pipe, err := winio.DialPipe(agentPipe, nil)
		if err != nil {
			// Служба ssh-agent на Windows по умолчанию отключена, и это самая
			// частая причина. Голое «файл не найден» отправляет искать не там.
			return nil, fmt.Errorf(
				"агент OpenSSH недоступен, проверьте службу ssh-agent: %w", err)
		}
		methods = append(methods, ssh.PublicKeysCallback(agent.NewClient(pipe).Signers))
	}

	if cfg.KeyPath != "" {
		raw, err := os.ReadFile(cfg.KeyPath)
		if err != nil {
			return nil, fmt.Errorf("чтение ключа: %w", err)
		}
		signer, err := ssh.ParsePrivateKey(raw)
		if err != nil {
			// Ключ под парольной фразой. Спрашивать её мы не будем никогда:
			// это работа агента.
			return nil, fmt.Errorf("ключ защищён парольной фразой, добавьте его в агент OpenSSH: %w", err)
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}

	if len(methods) == 0 {
		return nil, fmt.Errorf("не указан ни ключ, ни агент")
	}
	return methods, nil
}

func clientConfig(cfg Config, hk HostKeyPolicy) (*ssh.ClientConfig, error) {
	methods, err := authMethods(cfg)
	if err != nil {
		return nil, err
	}
	return &ssh.ClientConfig{
		User: cfg.User,
		Auth: methods,
		// Конверсией здесь не обойтись: у HostKeyPolicy два параметра, у
		// ssh.HostKeyCallback три (лишний - net.Addr). В Go функции с разным
		// числом параметров не приводятся друг к другу, нужен переходник.
		HostKeyCallback: func(hostname string, _ net.Addr, key ssh.PublicKey) error {
			return hk(hostname, key)
		},
		Timeout: 10 * time.Second,
	}, nil
}

func addr(cfg Config) string {
	port := cfg.Port
	if port == 0 {
		port = 22
	}
	return net.JoinHostPort(cfg.Host, strconv.Itoa(port))
}

// Dial поднимает соединение, при необходимости через бастион.
// ErrJumpFailed оборачивает любой отказ на стороне бастиона. Нужен именно
// маркер, а не текст: по нему StateForError отличает «лёг бастион» от «лёг
// сервер», а интерфейс говорит пользователю, какое звено чинить.
var ErrJumpFailed = errors.New("отказ на стороне бастиона")

func Dial(ctx context.Context, cfg Config, hk HostKeyPolicy) (Conn, error) {
	// redial повторяет ровно тот же путь, что и первое подключение, включая
	// бастион. Замыкание, а не сохранённые поля: так ветка «через бастион» не
	// расползается по двум местам.
	redial := func(ctx context.Context) (*ssh.Client, *ssh.Client, error) {
		return dialChain(ctx, cfg, hk)
	}

	target, bastion, err := dialChain(ctx, cfg, hk)
	if err != nil {
		return nil, err
	}
	return newConn(target, bastion, cfg, hk, redial), nil
}

// dialChain поднимает соединение напрямую или через бастион и возвращает обе
// стороны: цель и бастион (nil при прямом подключении). Бастион отдаётся
// наверх, чтобы его было чем закрыть - иначе он живёт до конца процесса.
// Вынесено из Dial отдельно, потому что вызывается ещё и при переподключении.
func dialChain(ctx context.Context, cfg Config, hk HostKeyPolicy) (*ssh.Client, *ssh.Client, error) {
	if cfg.JumpVia == nil {
		cl, err := dialDirect(ctx, cfg, hk)
		return cl, nil, err
	}

	// Сначала бастион. Его отказ отделён от отказа цели намеренно: сообщение
	// «сервер недоступен», когда на самом деле лёг бастион, отправляет чинить
	// не то.
	jump := *cfg.JumpVia
	jump.JumpVia = nil
	bastion, err := dialDirect(ctx, jump, hk)
	if err != nil {
		return nil, nil, fmt.Errorf("бастион %s недоступен: %w: %w", jump.Host, ErrJumpFailed, err)
	}

	raw, err := bastion.Dial("tcp", addr(cfg))
	if err != nil {
		bastion.Close()
		return nil, nil, fmt.Errorf("бастион не смог открыть канал до %s: %w: %w",
			cfg.Host, ErrJumpFailed, err)
	}

	cc, err := clientConfig(cfg, hk)
	if err != nil {
		raw.Close()
		bastion.Close()
		return nil, nil, err
	}
	ncc, chans, reqs, err := ssh.NewClientConn(raw, addr(cfg), cc)
	if err != nil {
		// raw закрывается тоже: NewClientConn при ошибке его не трогает, и
		// открытый канал остался бы висеть на бастионе.
		raw.Close()
		bastion.Close()
		return nil, nil, err
	}
	return ssh.NewClient(ncc, chans, reqs), bastion, nil
}

func dialDirect(ctx context.Context, cfg Config, hk HostKeyPolicy) (*ssh.Client, error) {
	cc, err := clientConfig(cfg, hk)
	if err != nil {
		return nil, err
	}
	d := net.Dialer{Timeout: cc.Timeout}
	raw, err := d.DialContext(ctx, "tcp", addr(cfg))
	if err != nil {
		return nil, err
	}
	ncc, chans, reqs, err := ssh.NewClientConn(raw, addr(cfg), cc)
	if err != nil {
		raw.Close()
		// Кому и чем стучались - обязательная часть отказа. «Ключ не принят»
		// без учётной записи заставляет искать вслепую: человек, вписавший в
		// поле пользователя имя файла ключа, ничего не заподозрит, потому что
		// его ошибка на экране не показана.
		return nil, fmt.Errorf("%s@%s (%s): %w", cfg.User, addr(cfg), credentialSource(cfg), err)
	}
	return ssh.NewClient(ncc, chans, reqs), nil
}

// credentialSource описывает, чем именно пробовали войти.
func credentialSource(cfg Config) string {
	switch {
	case cfg.UseAgent && cfg.KeyPath != "":
		return "агент OpenSSH и ключ " + cfg.KeyPath
	case cfg.UseAgent:
		return "агент OpenSSH"
	case cfg.KeyPath != "":
		return "ключ " + cfg.KeyPath
	default:
		return "без ключа"
	}
}
