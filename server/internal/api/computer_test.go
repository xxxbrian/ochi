package api

import (
	"bytes"
	"context"
	"io"
	"net/http/httptest"
	"testing"

	"ochi/server/internal/runtime"
)

type testDesktopSocket struct {
	bytes.Buffer
	closed bool
}

func TestGlobalDesktopControlDoesNotDependOnConversation(t *testing.T) {
	s := &Server{resources: newResourceManager(), desktops: newDesktopHub(), runtime: runtime.NewManager()}
	defer s.desktops.Close()
	if err := s.AcquireDesktopControl(context.Background(), "user", ""); err != nil {
		t.Fatal(err)
	}
	state := s.computerStateValue(context.Background(), "user", "")
	if state["control_enabled"] != true || state["desktop_url"] != "/api/computer/desktop?control=1" || state["owner_session_id"] != "" {
		t.Fatalf("global control unexpectedly needs a session: %+v", state)
	}
	if other := s.computerStateValue(context.Background(), "other", ""); other["busy"] != false || other["control_enabled"] != false {
		t.Fatal("global control crossed user boundary")
	}
	key := desktopConnectionKey("user", "")
	controlSocket, viewSocket := &testDesktopSocket{}, &testDesktopSocket{}
	control := &desktopConnection{ReadWriteCloser: controlSocket, onClose: func() {}}
	view := &desktopConnection{ReadWriteCloser: viewSocket, onClose: func() {}}
	s.desktops.add(key, control, true)
	s.desktops.add(key, view, false)
	s.desktops.CloseControls(key)
	s.ReleaseDesktopControl("user", "")
	if !controlSocket.closed || viewSocket.closed || s.DesktopState("user")["busy"] != false {
		t.Fatal("release closed the viewer or retained global control")
	}
}

func (s *testDesktopSocket) Close() error { s.closed = true; return nil }

func TestDesktopReleaseClosesControlConnections(t *testing.T) {
	hub := newDesktopHub()
	socket := &testDesktopSocket{}
	closed := 0
	c := &desktopConnection{ReadWriteCloser: socket}
	c.onClose = func() {
		hub.remove("user:session", c)
		closed++
	}
	hub.add("user:session", c)
	hub.CloseKey("user:session")
	if !socket.closed || closed != 1 {
		t.Fatal("control socket remains open after release")
	}
	_ = c.Close()
	if closed != 1 {
		t.Fatal("release should be idempotent")
	}
	hub.arm("unused", func() {})
	hub.Close()
	if len(hub.timers) != 0 {
		t.Fatal("shutdown retained the desktop lease timer")
	}
}

func TestDesktopSameOrigin(t *testing.T) {
	r := httptest.NewRequest("GET", "http://localhost:8090/api/computer/desktop", nil)
	r.Header.Set("Origin", "http://localhost:8090")
	if !sameOrigin(r) {
		t.Fatal("valid same origin rejected")
	}
	r.Header.Set("Origin", "https://unrelated.example")
	if sameOrigin(r) {
		t.Fatal("cross-origin authenticated desktop allowed")
	}
}

func TestDesktopViewDoesNotKeepControlLease(t *testing.T) {
	hub := newDesktopHub()
	defer hub.Close()
	control := &desktopConnection{ReadWriteCloser: &testDesktopSocket{}, onClose: func() {}}
	view := &desktopConnection{ReadWriteCloser: &testDesktopSocket{}, onClose: func() {}}
	hub.add("user:session", control, true)
	hub.add("user:session", view, false)
	if !hub.remove("user:session", control) {
		t.Fatal("view-only socket kept manual control lease")
	}
	hub.arm("user:session", func() {})
	otherView := &desktopConnection{ReadWriteCloser: &testDesktopSocket{}, onClose: func() {}}
	hub.add("user:session", otherView, false)
	if hub.timers["user:session"] == nil {
		t.Fatal("new viewer cancelled control release timer")
	}
}

var _ io.ReadWriteCloser = (*testDesktopSocket)(nil)
