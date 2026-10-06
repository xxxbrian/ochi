package agent

import (
	"errors"
	"sync"
)

// Model rounds are shared by explicitly requested isolated research and its
// parent. Transport retries remain separately bounded; this is not a token cap.
type ExecutionBudget struct {
	mu        sync.Mutex
	remaining int
	parent    *ExecutionBudget
}

func NewExecutionBudget(rounds int) *ExecutionBudget {
	return &ExecutionBudget{remaining: max(1, rounds)}
}

// Child caps share the parent's allowance. Lock order is always child ->
// parent; parents never acquire a child's lock or replenish consumed rounds.
func (b *ExecutionBudget) Fork(limit int) *ExecutionBudget {
	return &ExecutionBudget{remaining: max(0, limit), parent: b}
}

func (b *ExecutionBudget) AcquireModelRound() error {
	return b.AcquireReserved(0)
}

// Auxiliary compaction must not spend the request reserved for a final answer.
func (b *ExecutionBudget) AcquireReserved(reserve int) error {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.remaining <= max(0, reserve) {
		return errors.New("shared model-round budget exhausted")
	}
	if b.parent != nil {
		if err := b.parent.AcquireReserved(reserve); err != nil {
			return err
		}
	}
	b.remaining--
	return nil
}

func (b *ExecutionBudget) Remaining() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.parent != nil {
		return min(b.remaining, b.parent.Remaining())
	}
	return b.remaining
}
