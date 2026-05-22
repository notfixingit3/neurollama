package format

import "fmt"

func Bytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

func Count(n float64) string {
	switch {
	case n >= 1e12:
		return fmt.Sprintf("%.2fT", n/1e12)
	case n >= 1e9:
		return fmt.Sprintf("%.2fB", n/1e9)
	case n >= 1e6:
		return fmt.Sprintf("%.2fM", n/1e6)
	case n >= 1e3:
		return fmt.Sprintf("%.1fK", n/1e3)
	}
	return fmt.Sprintf("%.0f", n)
}

func Ctx(n int64) string {
	if n >= 1_000_000 {
		return fmt.Sprintf("%.1fM tokens", float64(n)/1e6)
	}
	if n >= 1_000 {
		return fmt.Sprintf("%dK tokens", n/1000)
	}
	return fmt.Sprintf("%d tokens", n)
}
