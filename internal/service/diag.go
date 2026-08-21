package service

import "github.com/zxczxczxczxczxczxc1111/veloce/internal/diag"

// DiagService даёт интерфейсу писать в тот же журнал, что и Go.
//
// Без него журнал показывает только половину цепочки: видно, что событие
// отправлено, но не видно, дошло ли оно до экрана и что экран с ним сделал.
// Ровно на этом стыке и застряли три круга разбора «почему ничего не
// происходит».
type DiagService struct{}

func NewDiagService() *DiagService { return &DiagService{} }

// Log пишет строку от интерфейса. Источник отделён, чтобы в журнале было
// видно, чей это голос.
func (d *DiagService) Log(message string) {
	diag.Logf("[ui] %s", message)
}

// Path отдаёт путь к журналу: пригодится, чтобы показать его человеку.
func (d *DiagService) Path() string { return diag.Path() }
