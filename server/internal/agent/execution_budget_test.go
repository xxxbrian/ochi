package agent

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestResearchBudgetHasLocalAndSharedCaps(t *testing.T) {
	parent := NewExecutionBudget(8)
	child := parent.Fork(6)
	for i := 0; i < 6; i++ {
		if err := child.AcquireModelRound(); err != nil {
			t.Fatal(err)
		}
	}
	if child.AcquireModelRound() == nil || parent.Remaining() != 2 || child.Remaining() != 0 {
		t.Fatal("local cap did not preserve parent allowance")
	}
	if parent.AcquireModelRound() != nil || parent.AcquireModelRound() != nil || parent.AcquireModelRound() == nil {
		t.Fatal("shared budget exhaustion")
	}
	if NewExecutionBudget(2).Fork(0).AcquireModelRound() == nil {
		t.Fatal("empty child acquired a round")
	}
	parent = NewExecutionBudget(20)
	left, right := parent.Fork(15), parent.Fork(15)
	var wg sync.WaitGroup
	var successes atomic.Int32
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			b := left
			if i%2 == 0 {
				b = right
			}
			if b.AcquireModelRound() == nil {
				successes.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if successes.Load() != 20 || parent.Remaining() != 0 || left.Remaining() != 0 || right.Remaining() != 0 {
		t.Fatal("parallel child caps overspent the parent")
	}
}
