package collect

import "testing"

const netdevFixture = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets
    lo: 1234567    8901    0    0    0     0          0         0 1234567    8901
  eth0: 98765432  123456    0    0    0     0          0         0 45678901   98765
`

func TestParseNetDev(t *testing.T) {
	got, err := ParseNetDev(netdevFixture)
	if err != nil {
		t.Fatalf("ParseNetDev: %v", err)
	}
	// lo не считаем: локальный трафик не про нагрузку на канал.
	if got.RxBytes != 98765432 || got.TxBytes != 45678901 {
		t.Fatalf("получено %+v", got)
	}
}

func TestNetRateSurvivesReset(t *testing.T) {
	prev := NetSample{RxBytes: 1000, TxBytes: 1000}
	cur := NetSample{RxBytes: 10, TxBytes: 10}
	rx, tx := NetRate(prev, cur, 2)
	if rx != 0 || tx != 0 {
		t.Fatalf("после обнуления счётчиков ожидались нули, получено %v %v", rx, tx)
	}
}
