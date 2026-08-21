package transport

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
)

// knownHostsPath - файл known_hosts текущего пользователя. Своей копии
// отпечатков приложение не заводит: два источника правды разъедутся в первый
// же день, и человек будет смотреть на «подтверждён» там, где ssh ругается.
func knownHostsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".ssh", "known_hosts"), nil
}

func readKnownHosts() ([]byte, error) {
	path, err := knownHostsPath()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	// Отсутствие файла это не поломка, а «ни один хост ещё не подтверждён».
	if os.IsNotExist(err) {
		return nil, nil
	}
	return raw, err
}

// KnownHostFingerprint отдаёт сохранённый отпечаток хоста или пустую строку,
// если хост ещё не подтверждён.
func KnownHostFingerprint(hostport string) (string, error) {
	raw, err := readKnownHosts()
	if err != nil {
		return "", err
	}
	return lookupKnownHost(raw, hostport), nil
}

// RemoveKnownHost убирает запись из known_hosts. Нужен, когда сервер
// пересоздали и ключ сменился законно: без этого пользователь идёт править
// файл руками.
func RemoveKnownHost(hostport string) error {
	raw, err := readKnownHosts()
	if err != nil || raw == nil {
		return err
	}
	out := filterKnownHost(raw, hostport)
	if len(out) == len(raw) {
		return nil // нечего забывать, файл не трогаем
	}
	path, err := knownHostsPath()
	if err != nil {
		return err
	}
	// Пишем через временный файл: обрыв посреди записи не должен оставить
	// пользователя с обрезанным known_hosts, это ломает ему и обычный ssh.
	tmp := path + ".veloce.tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// lookupKnownHost ищет отпечаток хоста в содержимом known_hosts.
//
// Разбираем построчно, а не одним ssh.ParseKnownHosts по всему файлу: на
// первой же битой строке разбор всего файла останавливается, а known_hosts у
// живого человека правится руками годами и мусор там есть всегда.
func lookupKnownHost(raw []byte, hostport string) string {
	for _, line := range strings.Split(string(raw), "\n") {
		marker, hosts, key, ok := parseKnownHostsLine(line)
		// Маркеры @revoked и @cert-authority это не «хост подтверждён».
		// Отозванный ключ, показанный как доверенный, хуже отсутствия ответа.
		if !ok || marker != "" {
			continue
		}
		if matchHostPatterns(hosts, hostport) {
			return ssh.FingerprintSHA256(key)
		}
	}
	return ""
}

// filterKnownHost возвращает содержимое файла без записей про этот хост.
// Остальные строки сохраняются дословно, включая комментарии: файл общий с
// обычным ssh, и переписывать его целиком в своём формате нельзя.
func filterKnownHost(raw []byte, hostport string) []byte {
	lines := strings.Split(string(raw), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		_, hosts, _, ok := parseKnownHostsLine(line)
		if ok && matchHostPatterns(hosts, hostport) {
			continue
		}
		kept = append(kept, line)
	}
	return []byte(strings.Join(kept, "\n"))
}

func parseKnownHostsLine(line string) (marker string, hosts []string, key ssh.PublicKey, ok bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return "", nil, nil, false
	}
	m, h, k, _, _, err := ssh.ParseKnownHosts([]byte(trimmed))
	if err != nil {
		return "", nil, nil, false
	}
	return m, h, k, true
}

// matchHostPatterns сверяет запись known_hosts с адресом вида host:port.
// Порт участвует в сравнении: тот же хост на 22 и на 2222 это две разные
// записи и, вообще говоря, могут быть два разных сервера.
func matchHostPatterns(hosts []string, hostport string) bool {
	host, port, err := net.SplitHostPort(hostport)
	if err != nil {
		host, port = hostport, "22"
	}
	plain := host
	if port != "22" {
		plain = "[" + host + "]:" + port
	}
	for _, p := range hosts {
		if strings.HasPrefix(p, "|1|") {
			// OpenSSH с HashKnownHosts=yes пишет только хеш. Не понимать этот
			// формат значит показывать «не подтверждён» тем, у кого хост
			// подтверждён.
			if hashedHostMatch(p, plain) {
				return true
			}
			continue
		}
		if strings.EqualFold(p, plain) {
			return true
		}
	}
	return false
}

func hashedHostMatch(pattern, host string) bool {
	parts := strings.Split(pattern, "|")
	if len(parts) != 4 {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := base64.StdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	mac := hmac.New(sha1.New, salt)
	mac.Write([]byte(host))
	return hmac.Equal(mac.Sum(nil), want)
}

// HostPort собирает адрес из хоста и порта, подставляя 22 вместо нуля. Живёт
// здесь, потому что отпечатки, политика ключей и слой сервисов обязаны считать
// адрес одинаково: разъедься они на один порт, отпечаток «пропадёт».
func HostPort(host string, port int) string {
	if port == 0 {
		port = 22
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}
