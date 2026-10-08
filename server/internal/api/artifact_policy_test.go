package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

type artifactPolicyGenerator func(context.Context, agent.Request, func(agent.Update) error) error

func (g artifactPolicyGenerator) Generate(ctx context.Context, req agent.Request, emit func(agent.Update) error) error {
	return g(ctx, req, emit)
}

type artifactPolicyFiles struct {
	coreEvalFilesystem
	paths        []map[string]string
	discoveries  int
	publications int
}

func (f *artifactPolicyFiles) Bridge(ctx context.Context, userID, method, route string, payload []byte) (int, http.Header, []byte, error) {
	if method == http.MethodGet && route == "/runs/artifacts" {
		f.discoveries++
		body, _ := json.Marshal(map[string]any{"artifacts": f.paths})
		return http.StatusOK, nil, body, nil
	}
	if method == http.MethodPost && route == "/publish" {
		f.publications++
	}
	return f.coreEvalFilesystem.Bridge(ctx, userID, method, route, payload)
}

func artifactPolicyFixture(t *testing.T) (coreHTTPFixture, *artifactPolicyFiles, agent.Request, *runtime.Run) {
	t.Helper()
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	ctx := context.Background()
	off := false
	if _, err := f.server.store.PatchPreferences(ctx, f.owner, &off, nil); err != nil {
		t.Fatal(err)
	}
	source := &artifactPolicyFiles{coreEvalFilesystem: coreEvalFilesystem{root: t.TempDir(), userID: f.owner}}
	f.server.SetTools(source)
	scope := agent.RunScope{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID, CWD: f.session.WorkspacePath, ComputeOnly: true}
	f.server.preparedScopes.Store(scope.RunID+":compute", true)
	f.server.preparedScopes.Store(scope.RunID+":last-mode", true)
	req := agent.Request{UserID: f.owner, SessionID: scope.SessionID, RunID: scope.RunID, Scope: scope, Config: &agent.Config{}}
	run, _ := f.server.runtime.Get(scope.RunID)
	return f, source, req, run
}

func TestResearchWorkingFilesNeverBecomeDeliverablesAtRunEnd(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(fmt.Sprintf("failed=%t", failed), func(t *testing.T) {
			f, source, req, run := artifactPolicyFixture(t)
			ctx := agent.WithRunScope(context.Background(), req.Scope)
			// Model-independent reproduction of the reported cloned-repo case:
			// real files exist, and the former discovery route offers all 100.
			for i := 0; i < 100; i++ {
				path := fmt.Sprintf("research/source-%03d.go", i)
				if err := source.write(ctx, path, []byte("reference source, not a requested deliverable\n")); err != nil {
					t.Fatal(err)
				}
				source.paths = append(source.paths, map[string]string{"path": req.Scope.CWD + "/" + path})
			}
			f.server.agent = artifactPolicyGenerator(func(_ context.Context, _ agent.Request, emit func(agent.Update) error) error {
				if err := emit(agent.Update{Step: &agent.Step{ID: "clone", Name: "exec", Status: "completed", Output: `{"exit_code":0}`}}); err != nil {
					return err
				}
				if failed {
					return errors.New("controlled research interruption")
				}
				return emit(agent.Update{Text: "Research answer with source links; no file requested."})
			})
			f.server.execute(run, req)
			stored, err := f.server.store.GetRun(ctx, f.owner, req.RunID)
			want := runtime.StatusCompleted
			if failed {
				want = runtime.StatusFailed
			}
			if err != nil || stored.Status != want || len(stored.Artifacts) != 0 || len(run.Snapshot().Artifacts) != 0 {
				t.Fatal("run finalization promoted working files into visible artifacts")
			}
			files, err := f.server.store.ListRunArtifacts(ctx, f.owner, req.RunID)
			if err != nil || len(files) != 0 || source.discoveries != 0 || source.publications != 0 {
				t.Fatal("run finalization discovered or published scratch files")
			}
			if _, err := source.read(ctx, "research/source-099.go"); err != nil {
				t.Fatal("private research files were removed instead of left in the workspace")
			}
		})
	}
}

func TestExplicitPublicationSurvivesCompletionWithoutImplicitNewVersion(t *testing.T) {
	f, source, req, run := artifactPolicyFixture(t)
	ctx := agent.WithRunScope(context.Background(), req.Scope)
	var delivered storage.Artifact
	f.server.agent = artifactPolicyGenerator(func(ctx context.Context, request agent.Request, emit func(agent.Update) error) error {
		write := func(content string) error {
			args, _ := json.Marshal(map[string]string{"path": "requested-script.py", "content": content})
			_, err := f.server.tools.Call(ctx, f.owner, "files_write", args)
			return err
		}
		if err := write("# requested final version\n"); err != nil {
			return err
		}
		result, err := f.server.tools.Call(ctx, f.owner, "publish_file", json.RawMessage(`{"path":"requested-script.py"}`))
		if err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(result.Output), &delivered); err != nil || delivered.ID == "" {
			return errors.New("explicit publication did not return a downloadable ID")
		}
		// Edits after publication are working state, not a new delivered version.
		if err := write("# private follow-up draft\n"); err != nil {
			return err
		}
		source.paths = []map[string]string{{"path": request.Scope.CWD + "/requested-script.py"}}
		return emit(agent.Update{Step: &agent.Step{ID: "write", Name: "files_write", Status: "completed"}, Text: "[Requested script](" + delivered.URL + ")"})
	})
	f.server.execute(run, req)
	stored, err := f.server.store.GetRun(ctx, f.owner, req.RunID)
	if err != nil || stored.Status != runtime.StatusCompleted || len(stored.Artifacts) != 1 || stored.Artifacts[0].ID != delivered.ID {
		t.Fatal("explicit delivery was lost or source edits were implicitly republished")
	}
	if source.discoveries != 0 || source.publications != 1 {
		t.Fatal("completion rescanned or republished the explicit deliverable")
	}
	file, err := f.server.store.GetArtifact(ctx, f.owner, delivered.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := artifactBytes(file)
	if err != nil || string(data) != "# requested final version\n" || file.Version != 1 {
		t.Fatal("source editing changed the delivered immutable bytes")
	}
	if sourceBytes, err := source.read(ctx, "requested-script.py"); err != nil || !strings.Contains(string(sourceBytes), "private follow-up") {
		t.Fatal("publication unexpectedly replaced the working source")
	}
	f.request(t, f.token, http.MethodGet, delivered.URL, "", http.StatusOK)
	f.request(t, f.foreign, http.MethodGet, delivered.URL, "", http.StatusNotFound)
}
