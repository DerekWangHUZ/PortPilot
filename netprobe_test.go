package main

import "testing"

func TestProbePortRejectsOutOfRange(t *testing.T) {
	for _, port := range []int{0, -1, 65536, 999999} {
		r := probePort(port)
		if r["listening"] != false || r["bindable"] != false {
			t.Errorf("port %d 应直接返回 false/false，got %v", port, r)
		}
	}
}

func TestProbePortValidPortShape(t *testing.T) {
	// 端口 1 几乎必然没人监听且可绑定（需要管理员权限的除外）；只验证结构
	r := probePort(1)
	if _, ok := r["listening"]; !ok {
		t.Fatal("缺少 listening 键")
	}
	if _, ok := r["bindable"]; !ok {
		t.Fatal("缺少 bindable 键")
	}
	if r["port"] != 1 {
		t.Fatalf("port=%v", r["port"])
	}
}

func TestProbePortsCapsEmptySlice(t *testing.T) {
	out := probePorts(nil)
	if len(out) != 0 {
		t.Fatalf("want empty, got %d", len(out))
	}
}
