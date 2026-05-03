// Phase 1 TextMate extractor fixture - Go declarations.
// Plain test data; not meant to be a runnable program.
package fixtures

import "errors"

type Widget struct {
	ID    string
	Label string
}

type Greeter interface {
	Greet() string
}

func New(id, label string) *Widget {
	return &Widget{ID: id, Label: label}
}

func (w *Widget) Greet() string {
	return "hello " + w.Label
}

func (w Widget) Describe() string {
	return w.ID + ":" + w.Label
}

type Status int

const (
	Idle Status = iota
	Active
)

func process(items []Widget) ([]Widget, error) {
	if len(items) == 0 {
		return nil, errors.New("empty")
	}
	return items, nil
}
