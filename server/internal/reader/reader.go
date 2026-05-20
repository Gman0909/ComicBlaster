package reader

import "io"

// FormatReader abstracts page access for any comic file format.
// Implementations register themselves via init() using Register.
type FormatReader interface {
	Open(path string) error
	PageCount() int
	// Page returns the content and MIME type for page n (0-indexed).
	Page(n int) (io.ReadCloser, string, error)
	Close() error
}

var registry = map[string]func() FormatReader{}

// Register adds a factory for the given lowercase file extension (e.g. ".cbz").
func Register(ext string, factory func() FormatReader) {
	registry[ext] = factory
}

// For returns a new FormatReader for the given extension, or nil if unsupported.
func For(ext string) FormatReader {
	f, ok := registry[ext]
	if !ok {
		return nil
	}
	return f()
}

// Supported returns all registered extensions.
func Supported() []string {
	out := make([]string, 0, len(registry))
	for ext := range registry {
		out = append(out, ext)
	}
	return out
}
