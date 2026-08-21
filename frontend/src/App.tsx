import { useEffect, useState } from 'react'
import { ServersService } from '../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service'

// Заглушка до фазы 5, где появятся токены оформления, словарь i18n и настоящий
// каркас экранов. Здесь ровно одно: доказать, что биндинги живые и Go отвечает.
// Строк интерфейса тут намеренно нет, только имя приложения и число.
function App() {
  const [count, setCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ServersService.List()
      // Go отдаёт nil-срез как null, и биндинг это честно типизирует.
      // Пустой список и отсутствие списка здесь одно и то же: ноль серверов.
      .then((list) => setCount(list?.length ?? 0))
      .catch((e: unknown) => setError(String(e)))
  }, [])

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ margin: 0 }}>Veloce</h1>
      <p>{error !== null ? error : count === null ? '...' : count}</p>
    </main>
  )
}

export default App
