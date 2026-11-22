package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 在 mihomo 的命名管道上手写 HTTP/1.1。
// 管道名优先取配置里的 external-controller-pipe，并把 sidecar-release- 换成实际可连的 production-。

type pipeResponse struct {
	Status int
	Reason string
	Body   string
	Raw    string
}

func (r *pipeResponse) ok() bool { return r != nil && r.Status >= 200 && r.Status < 300 }

var (
	pipeMu      sync.Mutex
	cachedPipe  string
	pipeSecret  string
	pipeLastErr string

	reDeclaredPipe   = regexp.MustCompile(`(?m)^\s*external-controller-pipe:\s*(.+?)\s*$`)
	reDeclaredSecret = regexp.MustCompile(`(?m)^\s*secret:\s*(.+?)\s*$`)
)

func shortPipeName(p string) string {
	if p == "" {
		return p
	}
	if len(p) >= len(pipePrefix) && strings.EqualFold(p[:len(pipePrefix)], pipePrefix) {
		return p[len(pipePrefix):]
	}
	return strings.TrimLeft(p, `\`)
}

func declaredPipe() string {
	text, err := readTextFile(clashConfigPath())
	if err != nil {
		return ""
	}
	m := reDeclaredPipe.FindStringSubmatch(text)
	if m == nil {
		return ""
	}
	return strings.Trim(strings.TrimSpace(m[1]), `'"`)
}

func declaredSecret() string {
	text, err := readTextFile(clashConfigPath())
	if err != nil {
		return ""
	}
	m := reDeclaredSecret.FindStringSubmatch(text)
	if m == nil {
		return ""
	}
	return strings.Trim(strings.TrimSpace(m[1]), `'"`)
}

func pipeSecretValue() string {
	pipeMu.Lock()
	defer pipeMu.Unlock()
	return pipeSecret
}

func setPipeSecret(v string) {
	pipeMu.Lock()
	pipeSecret = v
	pipeMu.Unlock()
}

func currentPipe() string {
	pipeMu.Lock()
	defer pipeMu.Unlock()
	return cachedPipe
}

func pipeError() string {
	pipeMu.Lock()
	defer pipeMu.Unlock()
	return pipeLastErr
}

func forgetPipe() {
	pipeMu.Lock()
	cachedPipe = ""
	pipeMu.Unlock()
}

func pipeCandidates() []string {
	var list []string
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" {
			return
		}
		key := strings.ToLower(p)
		if seen[key] {
			return
		}
		seen[key] = true
		list = append(list, p)
	}

	declared := declaredPipe()
	if declared != "" {
		add(declared)
		if strings.Contains(strings.ToLower(declared), "sidecar-release-") {
			add(reSwap(declared, "sidecar-release-", "production-"))
		}
		if strings.Contains(strings.ToLower(declared), "production-") {
			add(reSwap(declared, "production-", "sidecar-release-"))
		}
	}

	entries, err := os.ReadDir(pipePrefix)
	if err == nil {
		var mihomo []string
		for _, e := range entries {
			name := e.Name()
			ln := strings.ToLower(name)
			if strings.Contains(ln, "mihomo") || strings.Contains(ln, "clash") {
				mihomo = append(mihomo, pipePrefix+name)
			}
		}
		// production- 变体优先
		sort.Slice(mihomo, func(i, j int) bool {
			ri := 1
			if strings.Contains(strings.ToLower(mihomo[i]), "production-") {
				ri = 0
			}
			rj := 1
			if strings.Contains(strings.ToLower(mihomo[j]), "production-") {
				rj = 0
			}
			if ri != rj {
				return ri < rj
			}
			return strings.ToLower(mihomo[i]) < strings.ToLower(mihomo[j])
		})
		for _, p := range mihomo {
			add(p)
		}
	}
	return list
}

func reSwap(s, from, to string) string {
	idx := strings.Index(strings.ToLower(s), strings.ToLower(from))
	if idx < 0 {
		return s
	}
	return s[:idx] + to + s[idx+len(from):]
}

// discoverPipe 发现可用管道；成功返回完整管道路径。
// 候选管道并行探测（每个 1.5s 超时）：串行时 Verge 未运行最长要等 候选数×1.5s，
// 并行后总耗时不超过单次超时。顺序仍按 candidates 优先级取第一个成功者。
func discoverPipe(force bool) string {
	if !force {
		if p := currentPipe(); p != "" {
			return p
		}
	}
	candidates := pipeCandidates()
	type probe struct {
		idx  int
		pipe string // "" = 探测失败
	}
	ch := make(chan probe, len(candidates))
	for i, c := range candidates {
		go func(idx int, path string) {
			// 无论成败都要发一条：主循环固定接收 len(candidates) 次，
			// 只在成功时发送会因为没有候选成功而永久阻塞（自检已抓到过这个死锁）
			if r := requestOnPipe(path, "GET", "/version", "", 1500); r != nil && r.Status == 200 {
				ch <- probe{idx, path}
			} else {
				ch <- probe{idx, ""}
			}
		}(i, c)
	}
	alive, aliveIdx := "", -1
	for range candidates {
		p := <-ch
		if p.pipe != "" && (alive == "" || p.idx < aliveIdx) {
			alive, aliveIdx = p.pipe, p.idx
		}
	}
	pipeMu.Lock()
	cachedPipe = alive
	if alive == "" {
		if len(candidates) == 0 {
			pipeLastErr = "没有找到 Clash Verge 内核管道（Clash Verge 可能没有运行）"
		} else {
			pipeLastErr = "找到了 " + strconv.Itoa(len(candidates)) + " 个候选管道，但都连不上（Clash Verge 可能正在启动）"
		}
	}
	pipeMu.Unlock()
	return alive
}

func pipeRequest(method, path, body string, timeoutMs int) *pipeResponse {
	pipe := discoverPipe(false)
	if pipe == "" {
		return nil
	}
	r := requestOnPipe(pipe, method, path, body, timeoutMs)
	if r == nil {
		// 缓存失效，重新发现一次
		forgetPipe()
		pipe = discoverPipe(true)
		if pipe == "" {
			return nil
		}
		r = requestOnPipe(pipe, method, path, body, timeoutMs)
	}
	return r
}

func requestOnPipe(pipePath, method, path, body string, timeoutMs int) *pipeResponse {
	timeout := time.Duration(timeoutMs) * time.Millisecond

	f, err := openPipe(pipePath, minDuration(timeout, 4*time.Second))
	if err != nil {
		pipeMu.Lock()
		pipeLastErr = err.Error()
		pipeMu.Unlock()
		return nil
	}
	defer f.Close()

	var head strings.Builder
	head.WriteString(method + " " + path + " HTTP/1.1\r\n")
	head.WriteString("Host: localhost\r\n")
	if s := pipeSecretValue(); s != "" {
		head.WriteString("Authorization: Bearer " + s + "\r\n")
	}
	bodyBytes := []byte(body)
	if len(bodyBytes) > 0 {
		head.WriteString("Content-Type: application/json; charset=utf-8\r\n")
	}
	head.WriteString("Content-Length: " + strconv.Itoa(len(bodyBytes)) + "\r\n")
	head.WriteString("Connection: close\r\n\r\n")

	if _, err := f.WriteString(head.String()); err != nil {
		pipeMu.Lock()
		pipeLastErr = err.Error()
		pipeMu.Unlock()
		return nil
	}
	if len(bodyBytes) > 0 {
		if _, err := f.Write(bodyBytes); err != nil {
			pipeMu.Lock()
			pipeLastErr = err.Error()
			pipeMu.Unlock()
			return nil
		}
	}

	raw, err := readAllWithTimeout(f, timeout)
	if err != nil {
		pipeMu.Lock()
		pipeLastErr = err.Error()
		pipeMu.Unlock()
		return nil
	}
	return parsePipeResponse(raw)
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

// openPipe 在超时内连接管道；超时后放弃（管道名不存在时 CreateFile 会一直等）。
func openPipe(path string, timeout time.Duration) (*os.File, error) {
	type result struct {
		f   *os.File
		err error
	}
	ch := make(chan result, 1)
	go func() {
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		ch <- result{f, err}
	}()
	select {
	case r := <-ch:
		return r.f, r.err
	case <-time.After(timeout):
		go func() {
			// 迟到的连接要关掉，避免泄漏句柄
			if r := <-ch; r.f != nil {
				_ = r.f.Close()
			}
		}()
		return nil, errors.New("连接内核管道超时（" + shortPipeName(path) + "）")
	}
}

func readAllWithTimeout(f *os.File, timeout time.Duration) ([]byte, error) {
	type result struct {
		b   []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		b, err := io.ReadAll(f)
		ch <- result{b, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil && len(r.b) == 0 {
			return nil, r.err
		}
		return r.b, nil
	case <-time.After(timeout):
		_ = f.Close() // 尽量让读线程结束
		return nil, errors.New("等待内核响应超时（" + strconv.Itoa(int(timeout.Milliseconds())) + " 毫秒）")
	}
}

func parsePipeResponse(raw []byte) *pipeResponse {
	resp := &pipeResponse{Raw: string(raw)}
	sep := bytes.Index(raw, []byte("\r\n\r\n"))
	if sep < 0 {
		resp.Status = 0
		resp.Body = resp.Raw
		return resp
	}

	headText := string(raw[:sep])
	lines := strings.Split(headText, "\r\n")
	if len(lines) > 0 {
		parts := strings.Split(lines[0], " ")
		if len(parts) >= 2 {
			if code, err := strconv.Atoi(parts[1]); err == nil {
				resp.Status = code
			}
			if len(parts) >= 3 {
				resp.Reason = strings.Join(parts[2:], " ")
			}
		}
	}

	headers := map[string]string{}
	for _, line := range lines[1:] {
		c := strings.Index(line, ":")
		if c <= 0 {
			continue
		}
		headers[strings.ToLower(strings.TrimSpace(line[:c]))] = strings.TrimSpace(line[c+1:])
	}

	bodyStart := sep + 4
	if te, ok := headers["transfer-encoding"]; ok && strings.Contains(strings.ToLower(te), "chunked") {
		resp.Body = decodeChunked(raw, bodyStart)
		return resp
	}
	if cl, ok := headers["content-length"]; ok {
		if n, err := strconv.Atoi(cl); err == nil {
			if bodyStart+n > len(raw) {
				n = len(raw) - bodyStart
			}
			if n <= 0 {
				resp.Body = ""
			} else {
				resp.Body = string(raw[bodyStart : bodyStart+n])
			}
			return resp
		}
	}
	if bodyStart >= len(raw) {
		resp.Body = ""
	} else {
		resp.Body = string(raw[bodyStart:])
	}
	return resp
}

func decodeChunked(raw []byte, start int) string {
	var sb strings.Builder
	i := start
	for i < len(raw) {
		lineEnd := bytes.Index(raw[i:], []byte("\r\n"))
		if lineEnd < 0 {
			break
		}
		lineEnd += i
		sizeText := string(raw[i:lineEnd])
		if semi := strings.Index(sizeText, ";"); semi >= 0 {
			sizeText = sizeText[:semi]
		}
		size, err := strconv.ParseInt(strings.TrimSpace(sizeText), 16, 32)
		if err != nil {
			break
		}
		i = lineEnd + 2
		if size == 0 {
			break
		}
		if i+int(size) > len(raw) {
			size = int64(len(raw) - i)
		}
		sb.Write(raw[i : i+int(size)])
		i += int(size) + 2
	}
	return sb.String()
}
