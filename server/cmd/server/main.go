package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/api"
	"ochi/server/internal/storage"
	"ochi/server/internal/workspace"
)

func main() {
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}

	var accounts []api.Account
	var err error
	accountsJSON := os.Getenv("OCHI_USERS")
	if strings.TrimSpace(accountsJSON) != "" {
		accounts, err = api.ParseAccounts(accountsJSON)
		if err != nil {
			log.Fatal(err)
		}
	}
	var tools agent.ToolSource
	if strings.EqualFold(os.Getenv("WORKSPACE_ENABLED"), "true") {
		tools = workspace.NewDocker(workspace.Config{Socket: os.Getenv("DOCKER_SOCKET"), Image: os.Getenv("WORKSPACE_IMAGE"), Network: os.Getenv("WORKSPACE_NETWORK"), ComputeNetwork: os.Getenv("COMPUTE_NETWORK")})
	}
	var generator agent.Generator = agent.NewDynamic(tools)
	if os.Getenv("RUNNER") == "demo" {
		generator = agent.DemoGenerator{}
		log.Print("RUNNER=demo: simulated replies, no model calls or tools")
	}
	if os.Getenv("DATABASE_URL") == "" {
		log.Fatal("DATABASE_URL is required")
	}
	startup, cancelStartup := context.WithTimeout(context.Background(), 30*time.Second)
	store, err := storage.Open(startup, os.Getenv("DATABASE_URL"))
	if err != nil {
		cancelStartup()
		log.Fatal(err)
	}
	defer store.Close()
	if err := store.BootstrapProvider(startup, os.Getenv("MODEL_BASE_URL"), os.Getenv("MODEL_API_KEY"), os.Getenv("MODEL_NAME")); err != nil {
		cancelStartup()
		log.Fatal(err)
	}
	cancelStartup()
	application, err := api.NewServer(store, generator, accounts, strings.EqualFold(os.Getenv("SECURE_COOKIES"), "true"))
	if err != nil {
		log.Fatal(err)
	}
	application.SetTools(tools)
	application.StartQueue(context.Background())
	application.StartScheduler(context.Background())
	application.StartMemoryWorker(context.Background())

	srv := &http.Server{
		Addr:              addr,
		Handler:           application.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stopped)
	log.Printf("server listening on %s", addr)
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()
	select {
	case sig := <-stopped:
		if sig == syscall.SIGTERM {
			drain, cancelDrain := context.WithTimeout(context.Background(), 10*time.Minute)
			go func() {
				select {
				case <-stopped:
					cancelDrain()
				case <-drain.Done():
				}
			}()
			log.Print("server draining: new inputs stay queued; waiting up to 10 minutes for active runs")
			if err := application.Drain(drain); err != nil {
				log.Printf("run drain: %v; cancelling remaining work", err)
			}
			cancelDrain()
		}
	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP server: %v", err)
		}
	}
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 30*time.Second)
	// Drain producers before closing the pool, then allow SSE handlers to finish.
	if err := application.Shutdown(shutdown); err != nil {
		// Exit without closing the pool under a callback that ignored cancellation.
		// The next startup marks unfinished runs interrupted, as after a crash.
		log.Fatalf("run shutdown exceeded cleanup deadline: %v", err)
	}
	cancelShutdown()
	httpShutdown, cancelHTTP := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelHTTP()
	if err := srv.Shutdown(httpShutdown); err != nil {
		log.Printf("HTTP shutdown: %v", err)
		_ = srv.Close()
	}
}
