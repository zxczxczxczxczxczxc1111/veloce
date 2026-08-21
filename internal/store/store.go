package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Store struct {
	mu        sync.RWMutex
	path      string
	servers   []Server
	overrides []ProjectOverride
}

// diskFormat - то, что реально лежит в файле. Объект с двумя ключами, а не
// голый массив серверов: настройки проектов должны жить в том же файле, иначе
// при удалении сервера появляется вторая точка рассинхронизации.
type diskFormat struct {
	Servers   []Server          `json:"servers"`
	Overrides []ProjectOverride `json:"overrides"`
}

// DefaultPath - %APPDATA%\Veloce\servers.json. Рядом с бинарником конфиг не
// кладём: приложение должно переживать переустановку и не требовать прав на
// запись в Program Files.
func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "Veloce", "servers.json"), nil
}

func Open(path string) (*Store, error) {
	s := &Store{path: path}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil // первого запуска ещё не было, это нормально
	}
	if err != nil {
		return nil, err
	}
	var d diskFormat
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	s.servers, s.overrides = d.Servers, d.Overrides
	return s, nil
}

func (s *Store) List() []Server {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Server, len(s.servers))
	copy(out, s.servers)
	return out
}

func (s *Store) Get(id string) (Server, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, srv := range s.servers {
		if srv.ID == id {
			return srv, true
		}
	}
	return Server{}, false
}

func (s *Store) Put(srv Server) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for i := range s.servers {
		if s.servers[i].ID == srv.ID {
			s.servers[i] = srv
			found = true
			break
		}
	}
	if !found {
		s.servers = append(s.servers, srv)
	}
	return s.saveLocked()
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.servers[:0]
	for _, srv := range s.servers {
		if srv.ID != id {
			out = append(out, srv)
		}
	}
	s.servers = out

	// Настройки удалённого сервера уходят вместе с ним, иначе файл растёт
	// мусором от серверов, которых больше нет.
	kept := s.overrides[:0]
	for _, o := range s.overrides {
		if o.ServerID != id {
			kept = append(kept, o)
		}
	}
	s.overrides = kept

	return s.saveLocked()
}

func (s *Store) Overrides(serverID string) map[string]ProjectOverride {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]ProjectOverride{}
	for _, o := range s.overrides {
		if o.ServerID == serverID {
			out[o.Key()] = o
		}
	}
	return out
}

func (s *Store) PutOverride(o ProjectOverride) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for i := range s.overrides {
		if s.overrides[i].ServerID == o.ServerID && s.overrides[i].Key() == o.Key() {
			s.overrides[i] = o
			found = true
			break
		}
	}
	if !found {
		s.overrides = append(s.overrides, o)
	}
	return s.saveLocked()
}

// saveLocked пишет через временный файл: обрыв посреди записи не должен
// оставлять пользователя с обрезанным конфигом и потерянным списком серверов.
//
// Вызывается ТОЛЬКО при уже взятом s.mu. Раньше save брал блокировку заново
// после того, как вызывающий её отпустил: два одновременных изменения
// (сохранение сервера и правка настройки проекта в карточке) могли записать
// файл в порядке, обратном порядку изменений, и одна правка терялась. Весь
// конфиг это один файл, так что цена такой гонки - потерянные данные.
func (s *Store) saveLocked() error {
	raw, err := json.MarshalIndent(diskFormat{
		Servers: s.servers, Overrides: s.overrides,
	}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
