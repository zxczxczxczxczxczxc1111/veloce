// Package diag ведёт журнал диагностики в файл рядом с настройками.
//
// Нужен потому, что окно приложения нельзя расспросить: снимок экрана
// показывает результат, но не показывает, дошло ли событие, запустился ли
// такт и что ответил сервер. Три круга догадок по скриншотам стоили дороже,
// чем этот файл.
//
// Журнал НЕ содержит содержимого логов проектов и никаких секретов: только
// имена сущностей, состояния и счётчики.
package diag

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Размер, после которого файл начинается заново. Диагностика не должна
// незаметно съесть диск у человека, который забыл её выключить.
const maxSize = 1 << 20 // 1 МБ

var (
	mu      sync.Mutex
	file    *os.File
	size    int64
	enabled bool
	path    string
)

// Enable включает журнал. Путь - каталог настроек приложения.
func Enable(dir string) error {
	mu.Lock()
	defer mu.Unlock()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path = filepath.Join(dir, "veloce.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	file, size, enabled = f, st.Size(), true
	return nil
}

// Path отдаёт путь к журналу, чтобы его можно было показать человеку.
func Path() string {
	mu.Lock()
	defer mu.Unlock()
	return path
}

// Logf пишет строку с отметкой времени. Молчит, если журнал не включён:
// вызывать его можно откуда угодно, не проверяя ничего заранее.
func Logf(format string, args ...any) {
	mu.Lock()
	defer mu.Unlock()
	if !enabled || file == nil {
		return
	}
	line := time.Now().Format("15:04:05.000") + " " + fmt.Sprintf(format, args...) + "\n"
	n, err := file.WriteString(line)
	if err != nil {
		return
	}
	size += int64(n)
	if size <= maxSize {
		return
	}
	// Начинаем файл заново, а не ротируем: вторая копия журнала диагностики
	// никому не нужна, а место она займёт.
	file.Truncate(0)
	file.Seek(0, 0)
	size = 0
}
