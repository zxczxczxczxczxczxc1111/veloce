package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// IncidentsPerServer - предел кольца на один сервер. Лента без предела съедает
// диск незаметно: на сервере, куда стучатся круглосуточно, событий набегает
// быстрее, чем их успевают читать.
const IncidentsPerServer = 500

// Incident - происшествие, замеченное панелью. Хранится на диске, потому что
// единственный вопрос, ради которого лента вообще нужна, звучит как «что было
// ночью», а ночью приложение закрыто.
type Incident struct {
	ServerID string `json:"serverId"`
	At       int64  `json:"at"` // миллисекунды, как Date в JavaScript
	Source   string `json:"source"`
	Severity string `json:"severity"` // info | warning | critical
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	Read     bool   `json:"read"`
}

type IncidentStore struct {
	mu        sync.RWMutex
	path      string
	incidents []Incident
}

func OpenIncidents(path string) (*IncidentStore, error) {
	s := &IncidentStore{path: path}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil // первого события ещё не было
	}
	if err != nil {
		return nil, err
	}
	// Битый файл событий НЕ должен мешать работе панели: события это справка,
	// а не данные, ради которых человек её открыл.
	if err := json.Unmarshal(raw, &s.incidents); err != nil {
		s.incidents = nil
	}
	return s, nil
}

func (s *IncidentStore) Append(e Incident) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.incidents = append(s.incidents, e)
	s.trimLocked(e.ServerID)
	return s.saveLocked()
}

// AppendMany пишет пачку одним сохранением: такт приносит несколько событий
// сразу, и сохранять файл на каждое значит трогать диск впятеро чаще.
func (s *IncidentStore) AppendMany(list []Incident) error {
	if len(list) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[string]bool{}
	for _, e := range list {
		s.incidents = append(s.incidents, e)
		seen[e.ServerID] = true
	}
	for id := range seen {
		s.trimLocked(id)
	}
	return s.saveLocked()
}

// trimLocked оставляет последние IncidentsPerServer событий ОДНОГО сервера,
// не задевая остальные.
func (s *IncidentStore) trimLocked(serverID string) {
	count := 0
	for _, e := range s.incidents {
		if e.ServerID == serverID {
			count++
		}
	}
	if count <= IncidentsPerServer {
		return
	}
	drop := count - IncidentsPerServer
	kept := make([]Incident, 0, len(s.incidents)-drop)
	for _, e := range s.incidents {
		if e.ServerID == serverID && drop > 0 {
			drop--
			continue
		}
		kept = append(kept, e)
	}
	s.incidents = kept
}

func (s *IncidentStore) List(serverID string) []Incident {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Incident, 0, IncidentsPerServer)
	for _, e := range s.incidents {
		if e.ServerID == serverID {
			out = append(out, e)
		}
	}
	return out
}

func (s *IncidentStore) Unread(serverID string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, e := range s.incidents {
		if e.ServerID == serverID && !e.Read {
			n++
		}
	}
	return n
}

func (s *IncidentStore) MarkRead(serverID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.incidents {
		if s.incidents[i].ServerID == serverID {
			s.incidents[i].Read = true
		}
	}
	return s.saveLocked()
}

// saveLocked пишет через временный файл по той же причине, что и настройки:
// обрыв посреди записи не должен оставлять обрезанный файл.
func (s *IncidentStore) saveLocked() error {
	raw, err := json.MarshalIndent(s.incidents, "", "  ")
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
