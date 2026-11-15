package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"ochi/server/internal/agent"
	"ochi/server/internal/filelimits"
)

var filesCopyDefinition = agent.ToolDefinition{
	Name:        "files_copy",
	Description: "Copy one selected file between this conversation's isolated compute environment and its authorized persistent desktop environment. The filesystems are separate even when paths have the same spelling. Does not publish a downloadable artifact or copy a directory. Subject to the configured single-file transfer limit. Existing destination files are preserved unless overwrite is explicitly true.",
	Parameters:  json.RawMessage(`{"type":"object","properties":{"source_environment":{"type":"string","enum":["compute","desktop"]},"source_path":{"type":"string","minLength":1,"maxLength":4096},"destination_environment":{"type":"string","enum":["compute","desktop"]},"destination_path":{"type":"string","minLength":1,"maxLength":4096},"overwrite":{"type":"boolean"}},"required":["source_environment","source_path","destination_environment","destination_path"],"additionalProperties":false}`),
	Execution:   &agent.ToolExecution{},
}

func (s *Server) copyWorkspaceFile(ctx context.Context, scope agent.RunScope, args json.RawMessage) (agent.ToolResult, error) {
	var input struct {
		SourceEnvironment      string `json:"source_environment"`
		SourcePath             string `json:"source_path"`
		DestinationEnvironment string `json:"destination_environment"`
		DestinationPath        string `json:"destination_path"`
		Overwrite              bool   `json:"overwrite"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return agent.ToolResult{}, err
	}
	if input.SourceEnvironment == input.DestinationEnvironment {
		return agent.ToolResult{}, errors.New("files_copy requires different source and destination environments")
	}
	bridge, err := s.bridgeSource()
	if err != nil {
		return agent.ToolResult{}, err
	}
	source := scope
	source.ExecutionEnvironment = input.SourceEnvironment
	source, err = s.effectiveScope(ctx, source)
	if err != nil {
		return agent.ToolResult{}, err
	}
	destination := scope
	destination.ExecutionEnvironment = input.DestinationEnvironment
	destination, err = s.effectiveScope(ctx, destination)
	if err != nil {
		return agent.ToolResult{}, err
	}
	if !destination.ComputeOnly {
		if project := projectResource(destination.CWD); project != "" {
			// A file transfer mutates project data but never uses the GUI.
			if _, err := s.waitToolResources(ctx, destination, resourceRequest{
				Keys: []string{"project:" + project}, NoCheckpoint: true,
			}); err != nil {
				return agent.ToolResult{}, err
			}
		}
	}
	if _, err := s.prepareToolScope(ctx, source, bridge); err != nil {
		return agent.ToolResult{}, err
	}
	if _, err := s.prepareToolScope(ctx, destination, bridge); err != nil {
		return agent.ToolResult{}, err
	}
	status, _, data, err := bridgeFile(agent.WithRunScope(ctx, source), bridge, scope.UserID, http.MethodGet, "/file?path="+url.QueryEscape(input.SourcePath), nil, 0)
	if err != nil {
		return agent.ToolResult{}, err
	}
	if status >= 400 {
		_, err := bridgeReply(status, data, nil)
		return agent.ToolResult{}, err
	}
	defer data.Close()
	temp, err := os.CreateTemp("", "ochi-file-copy-")
	if err != nil {
		return agent.ToolResult{}, err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	size, err := io.Copy(temp, io.LimitReader(data, filelimits.MaxFileBytes()+1))
	if err != nil {
		return agent.ToolResult{}, err
	}
	if size > filelimits.MaxFileBytes() {
		return agent.ToolResult{}, errFileTooLarge
	}
	if _, err := temp.Seek(0, io.SeekStart); err != nil {
		return agent.ToolResult{}, err
	}
	query := url.Values{"path": {input.DestinationPath}}
	if !input.Overwrite {
		query.Set("if_missing", "1")
	}
	status, _, response, err := bridgeFile(agent.WithRunScope(ctx, destination), bridge, scope.UserID, http.MethodPut, "/file?"+query.Encode(), temp, size)
	body, err := bridgeReply(status, response, err)
	if err != nil {
		return agent.ToolResult{}, err
	}
	var result map[string]any
	if json.Unmarshal(body, &result) != nil || result == nil {
		return agent.ToolResult{}, errors.New("workspace returned an invalid file transfer result")
	}
	result["source_environment"], result["destination_environment"] = input.SourceEnvironment, input.DestinationEnvironment
	result["source_path"] = input.SourcePath
	result["message"] = "The selected file was copied. No artifact was published."
	if result["written"] == false {
		result["message"] = "The destination already exists and was preserved. The source file was not copied. Use overwrite only if replacing it is intended."
	}
	output, _ := json.Marshal(result)
	return agent.ToolResult{Output: string(output)}, nil
}

func resolveToolEnvironment(scope agent.RunScope, name string, args json.RawMessage) (agent.RunScope, error) {
	if name == "computer_queue" || name == "computer_release" || name == "files_copy" {
		scope.ExecutionEnvironment = "desktop"
		return scope, nil
	}
	if !computationTool(name) {
		return scope, nil
	}
	var input struct {
		Environment string `json:"environment"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return scope, err
	}
	if input.Environment == "" {
		input.Environment = "compute"
	}
	if input.Environment != "compute" && input.Environment != "desktop" {
		return scope, errors.New("execution environment must be compute or desktop")
	}
	scope.ExecutionEnvironment = input.Environment
	return scope, nil
}

func withExecutionEnvironment(result agent.ToolResult, scope agent.RunScope) agent.ToolResult {
	if scope.ExecutionEnvironment == "" {
		return result
	}
	var output map[string]any
	if json.Unmarshal([]byte(result.Output), &output) != nil || output == nil {
		return result
	}
	output["environment"] = scope.ExecutionEnvironment
	data, _ := json.Marshal(output)
	result.Output = string(data)
	return result
}

func independentPersonalTool(name string) bool {
	return personalTool(name) && !computationTool(name) && name != "files_copy" && !strings.HasPrefix(name, "computer_") && name != "skills_promote"
}
