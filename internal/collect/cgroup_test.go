package collect

import "testing"

const cpuStatFixture = `usage_usec 1234567890
user_usec 900000000
system_usec 334567890
nr_periods 0
`

func TestParseCgroupCPUStat(t *testing.T) {
	got, err := ParseCgroupCPUStat(cpuStatFixture)
	if err != nil {
		t.Fatalf("ParseCgroupCPUStat: %v", err)
	}
	if got.UsageUsec != 1234567890 {
		t.Fatalf("получено %+v", got)
	}
}

func TestCgroupCPUPercent(t *testing.T) {
	// За 2 секунды процесс потратил 1 секунду процессорного времени: 50%.
	if got := CgroupCPUPercent(0, 1_000_000, 2); got != 50 {
		t.Fatalf("получено %v, ожидалось 50", got)
	}
}

func TestParseCgroupMemory(t *testing.T) {
	got, err := ParseCgroupMemory("536870912\n")
	if err != nil {
		t.Fatalf("ParseCgroupMemory: %v", err)
	}
	if got != 536870912 {
		t.Fatalf("получено %d", got)
	}
}
