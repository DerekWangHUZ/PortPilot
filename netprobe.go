package main

import (
	"net"
	"strconv"
	"time"
)

// 端口探测：连通性（是否真的在监听）与可绑定性。只走回环。

func tcpProbe(port int, timeout time.Duration) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func canBindTCP(port int) bool {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func canBindUDP(port int) bool {
	pc, err := net.ListenPacket("udp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = pc.Close()
	return true
}

func probePort(port int) map[string]any {
	return map[string]any{
		"port":      port,
		"listening": tcpProbe(port, 350*time.Millisecond),
		"bindable":  canBindTCP(port) && canBindUDP(port),
	}
}

func probePorts(ports []int) []map[string]any {
	out := make([]map[string]any, 0, len(ports))
	for _, p := range ports {
		out = append(out, probePort(p))
	}
	return out
}
