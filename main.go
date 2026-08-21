package main

import (
	"embed"
	"log"

	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/diag"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/service"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/store"
)

// Директива embed и раздача ассетов приходят из шаблона wails3 init. При
// переписывании main.go их легко потерять: сборка при этом проходит, а окно
// открывается пустым, и причина совершенно неочевидна.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	path, err := store.DefaultPath()
	if err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(path)
	if err != nil {
		log.Fatal(err)
	}

	// Журнал диагностики рядом с настройками. Пишется всегда: он крошечный,
	// не содержит ни содержимого логов, ни секретов, а без него разбор
	// «почему на экране ничего не происходит» превращается в гадание по
	// скриншотам.
	if err := diag.Enable(filepath.Dir(path)); err != nil {
		log.Println("журнал диагностики не открыт:", err)
	}
	diag.Logf("=== запуск приложения ===")

	conns := service.NewConnRegistry()

	app := application.New(application.Options{
		Name: "Veloce",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
	})

	app.RegisterService(application.NewService(service.NewServersService(app, st, conns)))
	app.RegisterService(application.NewService(service.NewMetricsService(app, conns)))
	app.RegisterService(application.NewService(service.NewProjectsService(app, st, conns)))
	app.RegisterService(application.NewService(service.NewLogsService(app, conns)))
	// HealthService держит время последнего успешного ответа у себя, поэтому
	// он один на всё приложение: создай его заново на каждый экран, и «отвечал
	// 14 минут назад» обнулялось бы при каждом переходе.
	app.RegisterService(application.NewService(service.NewHealthService(conns)))
	app.RegisterService(application.NewService(service.NewDiagService()))

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "Veloce",
		Width:  1440,
		Height: 900,
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
