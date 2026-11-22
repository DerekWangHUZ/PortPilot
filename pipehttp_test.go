package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* parsePipeResponse：手写 HTTP/1.1 解析是管道通道的核心，边界必须锁死 */

func TestParsePipeResponseStatusAndBody(t *testing.T) {
	raw := []byte("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
	r := parsePipeResponse(raw)
	if r.Status != 204 || r.Reason != "No Content" || r.Body != "" {
		t.Fatalf("status=%d reason=%q body=%q", r.Status, r.Reason, r.Body)
	}
}

func TestParsePipeResponseContentLength(t *testing.T) {
	raw := []byte("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\n\r\n{\"version\":42}")
	r := parsePipeResponse(raw)
	if r.Status != 200 {
		t.Fatalf("status=%d", r.Status)
	}
	if r.Body != `{"version":42}` {
		t.Fatalf("body=%q", r.Body)
	}
}

func TestParsePipeResponseContentLengthTruncated(t *testing.T) {
	// CL 声明 30 字节但连接提前关闭：只回实际收到的部分，不能越界
	raw := []byte("HTTP/1.1 200 OK\r\nContent-Length: 30\r\n\r\nshort")
	r := parsePipeResponse(raw)
	if r.Body != "short" {
		t.Fatalf("body=%q", r.Body)
	}
}

func TestParsePipeResponseChunked(t *testing.T) {
	raw := []byte("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
		"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n")
	r := parsePipeResponse(raw)
	if r.Body != "hello world" {
		t.Fatalf("body=%q", r.Body)
	}
}

func TestParsePipeResponseChunkedTruncated(t *testing.T) {
	// 分块声明 10 字节但只到了 4 字节：取到多少算多少
	raw := []byte("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nA\r\nabcd")
	r := parsePipeResponse(raw)
	if r.Body != "abcd" {
		t.Fatalf("body=%q", r.Body)
	}
}

func TestParsePipeResponseNoHeaderSeparator(t *testing.T) {
	// 没有 \r\n\r\n：整体当 body，status=0（调用方按“没响应”处理）
	raw := []byte("garbage-without-headers")
	r := parsePipeResponse(raw)
	if r.Status != 0 || r.Body != string(raw) {
		t.Fatalf("status=%d body=%q", r.Status, r.Body)
	}
}

func TestParsePipeResponseCaseInsensitiveTE(t *testing.T) {
	raw := []byte("HTTP/1.1 200 OK\r\ntransfer-encoding: CHUNKED\r\n\r\n3\r\nabc\r\n0\r\n\r\n")
	r := parsePipeResponse(raw)
	if r.Body != "abc" {
		t.Fatalf("body=%q", r.Body)
	}
}

/* decodeChunked：分块解码边界 */

func TestDecodeChunkedWithExtensions(t *testing.T) {
	raw := []byte("4;ext=1\r\nabcd\r\n0\r\n\r\n")
	if got := decodeChunked(raw, 0); got != "abcd" {
		t.Fatalf("got %q", got)
	}
}

/* writeTextFileAtomic：原子写与唯一临时名 */

func TestWriteTextFileAtomicRoundTrip(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "sample.txt")
	if err := writeTextFileAtomic(p, "第一版\r\n"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "第一版\r\n" {
		t.Fatalf("got %q", b)
	}
	// 覆写
	if err := writeTextFileAtomic(p, "第二版"); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(p)
	if string(b) != "第二版" {
		t.Fatalf("overwrite got %q", b)
	}
}

func TestWriteTextFileAtomicUniqueTmpNames(t *testing.T) {
	// 两次写入都用 .portpilot-tmp 前缀；并发时文件名不同（pid+纳秒），
	// 串行调用后不应留下任何临时文件
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if err := writeTextFileAtomic(p, "x"); err != nil {
		t.Fatal(err)
	}
	if err := writeTextFileAtomic(p, "y"); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), "portpilot-tmp") {
			t.Fatalf("残留临时文件：%s", e.Name())
		}
	}
}

/* rotateIfNeeded：日志轮转 */

func TestRotateIfNeededTruncatesLargeLog(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "log.txt")
	big := strings.Repeat("x", 3*1024*1024) + "\nTailMark"
	if err := os.WriteFile(p, []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	rotateIfNeeded(p)
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() >= maxLogBytes {
		t.Fatalf("未截断：size=%d", st.Size())
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), "TailMark") {
		t.Fatalf("截断后丢失了尾部标记")
	}
}

func TestRotateIfNeededSkipsSmallLog(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "log.txt")
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	rotateIfNeeded(p)
	b, _ := os.ReadFile(p)
	if string(b) != "hello" {
		t.Fatalf("小文件被改动：%q", b)
	}
}

/* shortPipeName：管道路径展示 */

func TestShortPipeName(t *testing.T) {
	cases := []struct{ in, want string }{
		{`\\.\pipe\verge-mihomo-production-abc`, "verge-mihomo-production-abc"},
		{"", ""},
		{"plain-name", "plain-name"},
	}
	for _, c := range cases {
		if got := shortPipeName(c.in); got != c.want {
			t.Errorf("shortPipeName(%q)=%q want %q", c.in, got, c.want)
		}
	}
}
