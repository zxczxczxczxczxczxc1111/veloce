package collect

import "testing"

// Вывод `df -B1 --output=source,size,used,target`.
const dfFixture = `Filesystem          1B-blocks         Used Mounted on
udev               4118605824            0 /dev
/dev/vda1         84140130304  31258574848 /
tmpfs               823721984      1626112 /run
/dev/vda15          109422592      6299648 /boot/efi
`

func TestParseDF(t *testing.T) {
	got := ParseDF(dfFixture)
	// tmpfs, udev и прочие псевдофайловые системы отбрасываются: показывать
	// пользователю заполненность /dev бессмысленно.
	if len(got) != 2 {
		t.Fatalf("получено %d записей: %+v", len(got), got)
	}
	if got[0].Mount != "/" || got[0].SizeBytes != 84140130304 {
		t.Fatalf("первая запись %+v", got[0])
	}
}
