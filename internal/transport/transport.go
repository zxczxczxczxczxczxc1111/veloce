package transport

import (
	"context"
	"io"
)

// State - состояние соединения. Интерфейс показывает его дословно, поэтому
// значений ровно столько, сколько пользователь способен различить и как-то на
// них отреагировать.
type State int

const (
	StateDisconnected State = iota
	StateConnecting
	StateConnected
	StateAuthFailed     // ключ не принят, переподключаться бессмысленно
	StateHostKeyUnknown // хост не в known_hosts, нужно решение пользователя
	StateJumpFailed     // лёг бастион, а не цель
)

// Config описывает одно подключение. JumpVia - бастион; цепочка ограничена
// одним прыжком, поэтому у вложенного Config поле JumpVia игнорируется.
type Config struct {
	Host     string
	Port     int
	User     string
	KeyPath  string
	UseAgent bool
	JumpVia  *Config
}

// Result - итог одной команды. Code хранится отдельно от ошибки: ненулевой код
// это нормальный ответ сервера (нет такого юнита, нет docker), а не сбой связи.
type Result struct {
	Stdout string
	Stderr string
	Code   int
}

type Conn interface {
	Run(ctx context.Context, cmd string) (Result, error)
	Stream(ctx context.Context, cmd string) (io.ReadCloser, error)
	State() State
	// SetStateHook обязан быть в интерфейсе, а не только на *conn: Dial
	// возвращает Conn, и без этого метода слой сервисов не смог бы его
	// вызвать вовсе, а поле onState осталось бы мёртвым.
	SetStateHook(func(State))
	Close() error
}
