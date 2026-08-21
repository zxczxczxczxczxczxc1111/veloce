package transport

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// HostKeyPolicy решает, доверять ли ключу хоста.
type HostKeyPolicy func(hostport string, key ssh.PublicKey) error

// ErrHostKeyUnknown отдаётся наверх, чтобы интерфейс показал отпечаток и
// спросил пользователя. Молча принимать любой ключ нельзя: это ровно та дыра,
// ради закрытия которой SSH и придуман.
type ErrHostKeyUnknown struct {
	Host        string
	Fingerprint string
}

func (e *ErrHostKeyUnknown) Error() string {
	return fmt.Sprintf("неизвестный ключ хоста %s: %s", e.Host, e.Fingerprint)
}

// KnownHosts читает файл known_hosts пользователя Windows.
func KnownHosts() (HostKeyPolicy, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(home, ".ssh", "known_hosts")

	// Отсутствующий файл это не ошибка: у нового пользователя его просто нет,
	// каждый хост будет спрошен как неизвестный.
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return func(hostport string, key ssh.PublicKey) error {
			return &ErrHostKeyUnknown{Host: hostport, Fingerprint: ssh.FingerprintSHA256(key)}
		}, nil
	}

	check, err := knownhosts.New(path)
	if err != nil {
		return nil, err
	}
	return func(hostport string, key ssh.PublicKey) error {
		err := check(hostport, nil, key)
		if err == nil {
			return nil
		}
		var kerr *knownhosts.KeyError
		if ok := asKeyError(err, &kerr); ok && len(kerr.Want) == 0 {
			return &ErrHostKeyUnknown{Host: hostport, Fingerprint: ssh.FingerprintSHA256(key)}
		}
		// Want непустой значит ключ ЗАМЕНИЛСЯ. Это не «неизвестный хост», это
		// повод остановиться, поэтому ошибка идёт как есть.
		return err
	}, nil
}

// AppendKnownHost дописывает подтверждённый пользователем ключ.
func AppendKnownHost(hostport string, key ssh.PublicKey) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, "known_hosts"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	line := knownhosts.Line([]string{hostport}, key)
	_, err = f.WriteString(line + "\n")
	return err
}

func asKeyError(err error, target **knownhosts.KeyError) bool {
	return errors.As(err, target)
}
