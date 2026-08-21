package collect

import (
	"encoding/json"
	"strconv"
	"strings"
)

type Container struct {
	ID     string
	Name   string
	Image  string
	State  string
	Status string
}

type ContainerStat struct {
	Name       string
	CPUPercent float64
	MemBytes   uint64
}

// ParseDockerPS разбирает вывод `docker ps -a --format json`.
// Формат - NDJSON: по объекту на строку, не массив. Это стабильно ломает всех,
// кто пробует json.Unmarshal на всём выводе разом.
func ParseDockerPS(out string) ([]Container, error) {
	var res []Container
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var raw struct {
			ID     string `json:"ID"`
			Names  string `json:"Names"`
			Image  string `json:"Image"`
			State  string `json:"State"`
			Status string `json:"Status"`
		}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			return nil, err
		}
		// У контейнера может быть несколько имён через запятую, берём первое.
		name := raw.Names
		if i := strings.Index(name, ","); i >= 0 {
			name = name[:i]
		}
		res = append(res, Container{
			ID: raw.ID, Name: name, Image: raw.Image,
			State: raw.State, Status: raw.Status,
		})
	}
	return res, nil
}

func ParseDockerStats(out string) ([]ContainerStat, error) {
	var res []ContainerStat
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var raw struct {
			Name     string `json:"Name"`
			CPUPerc  string `json:"CPUPerc"`
			MemUsage string `json:"MemUsage"`
		}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			return nil, err
		}
		cpu, _ := strconv.ParseFloat(strings.TrimSuffix(raw.CPUPerc, "%"), 64)
		res = append(res, ContainerStat{
			Name:       raw.Name,
			CPUPercent: cpu,
			MemBytes:   parseMemUsage(raw.MemUsage),
		})
	}
	return res, nil
}

// parseMemUsage разбирает левую часть строки вида "512.3MiB / 7.66GiB".
// Правая часть это лимит, он нам не нужен.
func parseMemUsage(s string) uint64 {
	if i := strings.Index(s, "/"); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimSpace(s)

	units := []struct {
		suffix string
		mult   float64
	}{
		{"GiB", 1024 * 1024 * 1024},
		{"MiB", 1024 * 1024},
		{"KiB", 1024},
		{"GB", 1000 * 1000 * 1000},
		{"MB", 1000 * 1000},
		{"kB", 1000},
		{"B", 1},
	}
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			v, err := strconv.ParseFloat(strings.TrimSuffix(s, u.suffix), 64)
			if err != nil {
				return 0
			}
			return uint64(v * u.mult)
		}
	}
	return 0
}
