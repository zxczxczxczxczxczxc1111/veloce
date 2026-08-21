package collect

import "testing"

const meminfoFixture = `MemTotal:        8039424 kB
MemFree:          204816 kB
MemAvailable:    3125440 kB
Buffers:          131072 kB
Cached:          2764800 kB
`

func TestParseMeminfo(t *testing.T) {
	got, err := ParseMeminfo(meminfoFixture)
	if err != nil {
		t.Fatalf("ParseMeminfo: %v", err)
	}
	// Занято это Total минус Available, а не Total минус Free: кэш можно
	// отдать под нужды приложений, и считать его занятым неверно.
	if got.TotalBytes != 8039424*1024 {
		t.Fatalf("Total %d", got.TotalBytes)
	}
	if got.UsedBytes != (8039424-3125440)*1024 {
		t.Fatalf("Used %d", got.UsedBytes)
	}
}

func TestParseMeminfoWithoutAvailable(t *testing.T) {
	// Ядра старше 3.14 не отдают MemAvailable. Падать из-за этого нельзя.
	_, err := ParseMeminfo("MemTotal: 100 kB\nMemFree: 40 kB\n")
	if err != nil {
		t.Fatalf("должен работать без MemAvailable: %v", err)
	}
}
