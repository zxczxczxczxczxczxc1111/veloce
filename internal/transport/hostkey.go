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

// ErrHostKeyChanged отдаётся, когда у известного хоста ключ стал другим. Это
// НЕ то же самое, что неизвестный хост: там уместна кнопка «доверять», а здесь
// человек обязан сравнить два отпечатка и решить, пересобрали ему сервер или
// подменили. Поэтому оба отпечатка едут наверх вместе.
type ErrHostKeyChanged struct {
	Host        string
	Fingerprint string // тот, что пришёл сейчас
	Known       string // тот, что лежит в known_hosts
}

func (e *ErrHostKeyChanged) Error() string {
	return fmt.Sprintf("ключ хоста %s изменился: в known_hosts %s, пришёл %s",
		e.Host, e.Known, e.Fingerprint)
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
		// Адрес обязателен: knownhosts зовёт remote.String() безусловно, и на
		// nil вся программа падает паникой в первой же проверке известного
		// хоста. Раньше сюда приходил nil, и поймать это было нечем: тестов на
		// политику против настоящего файла не было.
		err := check(hostport, textAddr(hostport), key)
		if err == nil {
			return nil
		}
		var kerr *knownhosts.KeyError
		ok := asKeyError(err, &kerr)
		if ok && len(kerr.Want) == 0 {
			return &ErrHostKeyUnknown{Host: hostport, Fingerprint: ssh.FingerprintSHA256(key)}
		}
		// Want непустой значит ключ ЗАМЕНИЛСЯ. Это не «неизвестный хост», это
		// повод остановиться. Сохранённый отпечаток берём из того же файла:
		// показать один новый отпечаток без старого значит попросить человека
		// принять решение вслепую.
		if ok && len(kerr.Want) > 0 {
			return &ErrHostKeyChanged{
				Host:        hostport,
				Fingerprint: ssh.FingerprintSHA256(key),
				Known:       knownFingerprint(kerr),
			}
		}
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

// textAddr - адрес одной строкой. Своего net.Addr у нас нет: переходник из
// clientConfig выбрасывает адрес соединения, а знает только имя хоста.
type textAddr string

func (a textAddr) Network() string { return "tcp" }
func (a textAddr) String() string  { return string(a) }

func asKeyError(err error, target **knownhosts.KeyError) bool {
	return errors.As(err, target)
}

// knownFingerprint достаёт отпечаток сохранённого ключа из ошибки knownhosts.
// Записей может быть несколько (у хоста бывает по ключу на каждый алгоритм),
// берём первую: показываем ту, с которой ключ и разошёлся.
func knownFingerprint(kerr *knownhosts.KeyError) string {
	for _, w := range kerr.Want {
		if w.Key != nil {
			return ssh.FingerprintSHA256(w.Key)
		}
	}
	return ""
}
