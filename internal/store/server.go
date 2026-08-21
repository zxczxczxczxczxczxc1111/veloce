package store

// ProjectOverride - пользовательская настройка поверх обнаруженного проекта
// (раздел 6.3 спеки). Все поля необязательные: запись существует только для
// тех проектов, которые пользователь трогал руками. Обнаружение остаётся
// источником правды о том, что вообще есть на сервере.
type ProjectOverride struct {
	ServerID string `json:"serverId"`
	Kind     string `json:"kind"`  // docker | systemd
	ID       string `json:"id"`    // имя контейнера или юнита
	Label    string `json:"label"` // пусто - показываем ID как есть
	Hidden   bool   `json:"hidden"`
	Health   string `json:"health"` // URL проверки, пусто - проверки нет
}

// Key собирает ключ настройки. Kind в ключе обязателен: контейнер `nginx` и
// юнит `nginx.service` это разные сущности с разными настройками.
func (o ProjectOverride) Key() string { return o.Kind + ":" + o.ID }

// Server описывает подключение. Секретов здесь нет и быть не должно: только
// путь к ключу. Парольную фразу обслуживает агент OpenSSH.
type Server struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	User     string   `json:"user"`
	KeyPath  string   `json:"keyPath"`
	UseAgent bool     `json:"useAgent"`
	Tags     []string `json:"tags"`
	// JumpVia - ID другого сервера из этого же списка. Так учётные данные
	// бастиона лежат в одном месте, а не копируются в каждый сервер за ним.
	JumpVia string `json:"jumpVia"`
}
