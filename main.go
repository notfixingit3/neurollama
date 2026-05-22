package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/color"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

// ---------- SF fonts ----------

var (
	sfRegular    fyne.Resource
	sfItalic     fyne.Resource
	sfMono       fyne.Resource
	sfMonoItalic fyne.Resource
)

func init() {
	tryFont := func(path string) fyne.Resource {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		return fyne.NewStaticResource(filepath.Base(path), data)
	}
	sfRegular    = tryFont("/System/Library/Fonts/SFNS.ttf")
	sfItalic     = tryFont("/System/Library/Fonts/SFNSItalic.ttf")
	sfMono       = tryFont("/System/Library/Fonts/SFNSMono.ttf")
	sfMonoItalic = tryFont("/System/Library/Fonts/SFNSMonoItalic.ttf")
}

// ---------- theme ----------

type appTheme struct{}

var _ fyne.Theme = (*appTheme)(nil)

func (appTheme) Color(name fyne.ThemeColorName, variant fyne.ThemeVariant) color.Color {
	switch name {
	case theme.ColorNameBackground:
		return color.NRGBA{R: 15, G: 23, B: 42, A: 255}
	case theme.ColorNameMenuBackground, theme.ColorNameOverlayBackground:
		return color.NRGBA{R: 30, G: 41, B: 59, A: 255}
	case theme.ColorNameButton, theme.ColorNameDisabledButton:
		return color.NRGBA{R: 30, G: 41, B: 59, A: 255}
	case theme.ColorNameInputBackground:
		return color.NRGBA{R: 22, G: 31, B: 47, A: 255}
	case theme.ColorNamePrimary, theme.ColorNameFocus:
		return color.NRGBA{R: 99, G: 102, B: 241, A: 255}
	case theme.ColorNameHover:
		return color.NRGBA{R: 99, G: 102, B: 241, A: 38}
	case theme.ColorNameSelection:
		return color.NRGBA{R: 99, G: 102, B: 241, A: 70}
	case theme.ColorNameForeground:
		return color.NRGBA{R: 241, G: 245, B: 249, A: 255}
	case theme.ColorNameDisabled, theme.ColorNamePlaceHolder:
		return color.NRGBA{R: 100, G: 116, B: 139, A: 255}
	case theme.ColorNameSeparator:
		return color.NRGBA{R: 51, G: 65, B: 85, A: 255}
	case theme.ColorNameScrollBar:
		return color.NRGBA{R: 99, G: 102, B: 241, A: 100}
	case theme.ColorNameShadow:
		return color.NRGBA{R: 0, G: 0, B: 0, A: 140}
	case theme.ColorNameError:
		return color.NRGBA{R: 248, G: 81, B: 73, A: 255}
	case theme.ColorNameSuccess:
		return color.NRGBA{R: 63, G: 185, B: 80, A: 255}
	case theme.ColorNameWarning:
		return color.NRGBA{R: 210, G: 153, B: 34, A: 255}
	}
	return theme.DefaultTheme().Color(name, theme.VariantDark)
}

func (appTheme) Font(style fyne.TextStyle) fyne.Resource {
	switch {
	case style.Monospace && style.Italic && sfMonoItalic != nil:
		return sfMonoItalic
	case style.Monospace && sfMono != nil:
		return sfMono
	case style.Italic && sfItalic != nil:
		return sfItalic
	case sfRegular != nil:
		return sfRegular
	}
	return theme.DefaultTheme().Font(style)
}

func (appTheme) Icon(name fyne.ThemeIconName) fyne.Resource {
	return theme.DefaultTheme().Icon(name)
}

func (appTheme) Size(name fyne.ThemeSizeName) float32 {
	switch name {
	case theme.SizeNameText:
		return 14
	case theme.SizeNamePadding:
		return 6
	case theme.SizeNameInnerPadding:
		return 10
	case theme.SizeNameLineSpacing:
		return 4
	}
	return theme.DefaultTheme().Size(name)
}

// ---------- data types ----------

type OllamaServer struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"baseURL"`
}

type OllamaModel struct {
	Name       string
	Quant      string
	SizeBytes  int64
	SizeString string
}

type ModelInfo struct {
	Modelfile  string         `json:"modelfile"`
	Parameters string         `json:"parameters"`
	Template   string         `json:"template"`
	Details    ModelDetails   `json:"details"`
	ModelInfo  map[string]any `json:"model_info"`
}

type ModelDetails struct {
	ParentModel       string   `json:"parent_model"`
	Format            string   `json:"format"`
	Family            string   `json:"family"`
	Families          []string `json:"families"`
	ParameterSize     string   `json:"parameter_size"`
	QuantizationLevel string   `json:"quantization_level"`
}

// ---------- globals ----------

var (
	servers          []OllamaServer
	currentServer    *OllamaServer
	models           []OllamaModel
	selected         map[string]bool
	lastUsedServerID string

	httpClient = &http.Client{Timeout: 10 * time.Second}
)

// ---------- main ----------

func main() {
	a := app.New()
	a.Settings().SetTheme(&appTheme{})
	w := a.NewWindow("Ollama Manager")
	w.Resize(fyne.NewSize(1020, 720))

	loadConfig()
	if len(servers) > 0 {
		for i := range servers {
			if servers[i].ID == lastUsedServerID {
				currentServer = &servers[i]
				break
			}
		}
		if currentServer == nil {
			currentServer = &servers[0]
		}
	}
	selected = make(map[string]bool)

	// ----- forward declarations -----
	var refreshModels    func()
	var rebuildModelRows func()
	var rebuildSelect    func()
	var optionToID       map[string]string

	// ----- static widgets -----

	var suppressSelectChange bool
	serverSelect := widget.NewSelect(nil, nil)

	statsLabel := widget.NewLabel("Select a server to connect")

	refreshBtn := widget.NewButtonWithIcon("", theme.ViewRefreshIcon(), nil)
	manageBtn  := widget.NewButtonWithIcon("Servers", theme.SettingsIcon(), nil)
	quitBtn    := widget.NewButtonWithIcon("Quit", theme.LogoutIcon(), func() { a.Quit() })

	pullEntry := widget.NewEntry()
	pullEntry.SetPlaceHolder("model name or https://…/model.gguf")
	pullBtn := widget.NewButton("Pull", nil)
	pullBtn.Importance = widget.HighImportance

	deleteBtn := widget.NewButtonWithIcon("Delete Selected", theme.DeleteIcon(), nil)
	deleteBtn.Importance = widget.DangerImportance

	// Scrollable VBox — rows are built dynamically by rebuildModelRows.
	modelVBox   := container.NewVBox()
	modelScroll := container.NewScroll(modelVBox)

	// ----- logic closures -----

	rebuildSelect = func() {
		suppressSelectChange = true
		optionToID = make(map[string]string, len(servers))
		options := make([]string, len(servers))
		var currentDisplay string

		for i, s := range servers {
			label := s.Name
			if s.ID == lastUsedServerID {
				label = s.Name + "  ★"
			}
			options[i] = label
			optionToID[label] = s.ID
			if currentServer != nil && s.ID == currentServer.ID {
				currentDisplay = label
			}
		}

		serverSelect.Options = options
		serverSelect.Refresh()
		if currentDisplay != "" {
			serverSelect.SetSelected(currentDisplay)
		} else {
			serverSelect.ClearSelected()
		}
		suppressSelectChange = false
	}

	// rebuildModelRows re-creates every model row in modelVBox.
	// Each row has a header (checkbox + name + quant·size + chevron) and a
	// hidden detail panel that expands in-place when the chevron is tapped.
	rebuildModelRows = func() {
		modelVBox.RemoveAll()

		if len(models) == 0 {
			modelVBox.Add(widget.NewLabelWithStyle(
				"No models found. Pull one using the field below.",
				fyne.TextAlignCenter, fyne.TextStyle{Italic: true}))
			return
		}

		for i := range models {
			m := models[i] // local copy for closures

			check := widget.NewCheck("", nil)
			check.SetChecked(selected[m.Name])
			check.OnChanged = func(v bool) { selected[m.Name] = v }

			nameLabel    := widget.NewLabel(m.Name)
			detailsLabel := widget.NewLabel(m.Quant + "  ·  " + m.SizeString)

			// Detail panel — hidden until the row is expanded
			detailPanel := container.NewVBox()
			detailPanel.Hide()

			chevron := widget.NewButtonWithIcon("", theme.MenuDropDownIcon(), nil)
			chevron.OnTapped = func() {
				if detailPanel.Visible() {
					// collapse
					chevron.SetIcon(theme.MenuDropDownIcon())
					detailPanel.Hide()
					modelScroll.Refresh()
					return
				}
				// expand — show a spinner, then fetch
				chevron.SetIcon(theme.MenuDropUpIcon())
				detailPanel.RemoveAll()
				detailPanel.Add(widget.NewProgressBarInfinite())
				detailPanel.Show()
				modelScroll.Refresh()

				srv := currentServer
				go func() {
					info, err := fetchModelInfo(srv, m.Name)
					content := container.NewPadded(renderModelDetail(info, err))
					fyne.Do(func() {
						detailPanel.RemoveAll()
						detailPanel.Add(content)
						modelScroll.Refresh()
					})
				}()
			}

			header := container.NewBorder(nil, nil, check,
				container.NewHBox(detailsLabel, chevron), nameLabel)

			modelVBox.Add(container.NewVBox(header, detailPanel))

			if i < len(models)-1 {
				modelVBox.Add(widget.NewSeparator())
			}
		}
	}

	refreshModels = func() {
		if currentServer == nil {
			models = nil
			selected = make(map[string]bool)
			rebuildModelRows()
			statsLabel.SetText("No server selected")
			return
		}
		statsLabel.SetText("Connecting…")
		modelVBox.RemoveAll()
		modelVBox.Add(widget.NewProgressBarInfinite())

		srv := currentServer
		go func() {
			newModels := fetchModels(srv)
			version   := fetchVersion(srv)
			if currentServer == nil || currentServer.ID != srv.ID {
				return
			}
			// compute stats off the main thread
			var total int64
			for _, m := range newModels {
				total += m.SizeBytes
			}
			text := fmt.Sprintf("%d models  ·  %s total", len(newModels), formatBytes(total))
			if version != "" {
				text = fmt.Sprintf("Ollama v%s  ·  %d models  ·  %s total",
					version, len(newModels), formatBytes(total))
			}
			fyne.Do(func() {
				if currentServer == nil || currentServer.ID != srv.ID {
					return
				}
				models = newModels
				selected = make(map[string]bool)
				rebuildModelRows()
				statsLabel.SetText(text)
			})
		}()
	}

	// ----- event wiring -----

	serverSelect.OnChanged = func(display string) {
		if suppressSelectChange {
			return
		}
		id := optionToID[display]
		for i := range servers {
			if servers[i].ID == id {
				currentServer    = &servers[i]
				lastUsedServerID = id
				saveConfig()
				rebuildSelect()
				refreshModels()
				return
			}
		}
	}

	pullBtn.OnTapped = func() {
		if currentServer == nil || strings.TrimSpace(pullEntry.Text) == "" {
			return
		}
		input := strings.TrimSpace(pullEntry.Text)
		pullEntry.SetText("")
		go func() {
			fyne.Do(func() {
				dialog.ShowCustom("Pulling…", "Please wait",
					widget.NewLabel("Downloading "+input+"…"), w)
			})
			if err := pullModel(currentServer, input); err != nil {
				fyne.Do(func() { dialog.ShowError(err, w) })
			} else {
				fyne.Do(func() {
					dialog.ShowInformation("Done", input+" pulled successfully.", w)
					refreshModels()
				})
			}
		}()
	}

	deleteBtn.OnTapped = func() {
		if currentServer == nil {
			return
		}
		var toDelete []string
		for name, sel := range selected {
			if sel {
				toDelete = append(toDelete, name)
			}
		}
		if len(toDelete) == 0 {
			return
		}
		sort.Strings(toDelete)
		msg := fmt.Sprintf("Permanently delete %d model(s)?\n\n%s",
			len(toDelete), strings.Join(toDelete, "\n"))
		dialog.ShowConfirm("Confirm Delete", msg, func(ok bool) {
			if ok {
				for _, name := range toDelete {
					deleteModel(currentServer, name)
				}
				refreshModels()
			}
		}, w)
	}

	refreshBtn.OnTapped = refreshModels

	manageBtn.OnTapped = func() {
		showManageServersDialog(w, func() {
			rebuildSelect()
			refreshModels()
		})
	}

	// ----- layout -----

	headerRow := container.NewBorder(nil, nil,
		widget.NewLabel("Server:"),
		container.NewHBox(refreshBtn, manageBtn, quitBtn),
		serverSelect,
	)
	header := container.NewVBox(headerRow, statsLabel, widget.NewSeparator())

	pullRow := container.NewBorder(nil, nil, nil, pullBtn, pullEntry)
	footer := container.NewVBox(
		widget.NewSeparator(),
		pullRow,
		container.NewHBox(layout.NewSpacer(), deleteBtn),
	)

	w.SetContent(container.NewPadded(
		container.NewBorder(header, footer, nil, nil, modelScroll),
	))

	rebuildSelect()
	if currentServer != nil {
		refreshModels()
	}

	w.ShowAndRun()
}

// ---------- config ----------

func getConfigPath() string {
	dir, _ := os.UserConfigDir()
	return filepath.Join(dir, "ollama-manager", "config.json")
}

func loadConfig() {
	data, err := os.ReadFile(getConfigPath())
	if err != nil {
		// try legacy path
		data, err = os.ReadFile(filepath.Join(filepath.Dir(getConfigPath()), "servers.json"))
		if err != nil {
			return
		}
	}
	// new format: {"lastUsedServerID":"…","servers":[…]}
	var cfg struct {
		LastUsedServerID string         `json:"lastUsedServerID"`
		Servers          []OllamaServer `json:"servers"`
	}
	if json.Unmarshal(data, &cfg) == nil && cfg.Servers != nil {
		servers          = cfg.Servers
		lastUsedServerID = cfg.LastUsedServerID
		return
	}
	// legacy flat array
	json.Unmarshal(data, &servers)
}

func saveConfig() {
	path := getConfigPath()
	os.MkdirAll(filepath.Dir(path), 0755)
	cfg := struct {
		LastUsedServerID string         `json:"lastUsedServerID"`
		Servers          []OllamaServer `json:"servers"`
	}{
		LastUsedServerID: lastUsedServerID,
		Servers:          servers,
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	os.WriteFile(path, data, 0644)
}

// ---------- API ----------

func fetchModels(server *OllamaServer) []OllamaModel {
	resp, err := httpClient.Get(server.BaseURL + "/api/tags")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	var result struct {
		Models []struct {
			Name    string `json:"name"`
			Size    int64  `json:"size"`
			Details struct {
				QuantizationLevel string `json:"quantization_level"`
			} `json:"details"`
		} `json:"models"`
	}
	json.NewDecoder(resp.Body).Decode(&result)

	var list []OllamaModel
	for _, m := range result.Models {
		q := m.Details.QuantizationLevel
		if q == "" {
			q = "N/A"
		}
		list = append(list, OllamaModel{
			Name:       m.Name,
			Quant:      q,
			SizeBytes:  m.Size,
			SizeString: formatBytes(m.Size),
		})
	}
	return list
}

func fetchVersion(server *OllamaServer) string {
	resp, err := httpClient.Get(server.BaseURL + "/api/version")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var result struct {
		Version string `json:"version"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	return result.Version
}

func fetchModelInfo(server *OllamaServer, name string) (*ModelInfo, error) {
	if server == nil {
		return nil, fmt.Errorf("no server selected")
	}
	body := map[string]string{"name": name}
	data, _ := json.Marshal(body)
	resp, err := httpClient.Post(server.BaseURL+"/api/show", "application/json", bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var info ModelInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	return &info, nil
}

func pullModel(server *OllamaServer, input string) error {
	body := map[string]string{"name": input}
	data, _ := json.Marshal(body)
	resp, err := httpClient.Post(server.BaseURL+"/api/pull", "application/json", bytes.NewBuffer(data))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("pull failed with status %d", resp.StatusCode)
	}
	return nil
}

func deleteModel(server *OllamaServer, name string) {
	body := map[string]string{"name": name}
	data, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodDelete, server.BaseURL+"/api/delete", bytes.NewBuffer(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	httpClient.Do(req)
}

// ---------- formatting ----------

func formatBytes(b int64) string {
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

func formatCount(n float64) string {
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

func formatCtx(n int64) string {
	if n >= 1_000_000 {
		return fmt.Sprintf("%.1fM tokens", float64(n)/1e6)
	}
	if n >= 1_000 {
		return fmt.Sprintf("%dK tokens", n/1000)
	}
	return fmt.Sprintf("%d tokens", n)
}

// ---------- model detail renderer ----------

func renderModelDetail(info *ModelInfo, err error) fyne.CanvasObject {
	if err != nil {
		return widget.NewLabelWithStyle("Could not load details: "+err.Error(),
			fyne.TextAlignLeading, fyne.TextStyle{Italic: true})
	}
	if info == nil {
		return widget.NewLabelWithStyle("No details available.",
			fyne.TextAlignCenter, fyne.TextStyle{Italic: true})
	}

	var kvs []fyne.CanvasObject
	add := func(key, val string) {
		if val == "" {
			return
		}
		kvs = append(kvs,
			widget.NewLabelWithStyle(key, fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
			widget.NewLabel(val),
		)
	}

	add("Format", strings.ToUpper(info.Details.Format))
	add("Family", info.Details.Family)
	add("Parameter size", info.Details.ParameterSize)
	add("Quantization", info.Details.QuantizationLevel)
	if info.Details.ParentModel != "" {
		add("Based on", info.Details.ParentModel)
	}

	arch, _ := info.ModelInfo["general.architecture"].(string)
	if arch != "" {
		pfx := arch + "."
		getF := func(key string) (float64, bool) {
			v, ok := info.ModelInfo[pfx+key]
			if !ok {
				return 0, false
			}
			n, ok := v.(float64)
			return n, ok
		}
		if n, ok := getF("context_length"); ok {
			add("Context window", formatCtx(int64(n)))
		}
		if n, ok := getF("embedding_length"); ok {
			add("Embedding dim", fmt.Sprintf("%d", int64(n)))
		}
		if n, ok := getF("block_count"); ok {
			add("Layers", fmt.Sprintf("%d", int64(n)))
		}
		if n, ok := getF("attention.head_count"); ok {
			add("Attn heads", fmt.Sprintf("%d", int64(n)))
		}
		if n, ok := getF("attention.head_count_kv"); ok {
			add("KV heads", fmt.Sprintf("%d", int64(n)))
		}
	}
	if v, ok := info.ModelInfo["general.parameter_count"].(float64); ok && v > 0 {
		add("Parameters", formatCount(v))
	}

	if info.Parameters != "" {
		for _, line := range strings.Split(info.Parameters, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var key, val string
			if idx := strings.IndexByte(line, '\t'); idx >= 0 {
				key = strings.TrimSpace(line[:idx])
				val = strings.Trim(strings.TrimSpace(line[idx+1:]), `"`)
			} else {
				parts := strings.SplitN(line, " ", 2)
				if len(parts) == 2 {
					key, val = parts[0], strings.TrimSpace(parts[1])
				}
			}
			switch key {
			case "temperature":
				add("Temperature", val)
			case "top_p":
				add("Top-p", val)
			case "top_k":
				add("Top-k", val)
			case "num_ctx":
				add("Num context", val)
			}
		}
	}

	if len(kvs) == 0 {
		return widget.NewLabelWithStyle("No details available.",
			fyne.TextAlignCenter, fyne.TextStyle{Italic: true})
	}
	return container.NewGridWithColumns(2, kvs...)
}

// ---------- server dialogs ----------

func showServerForm(title, confirmLabel, initName, initURL string,
	onConfirm func(name, url string), w fyne.Window) {

	nameEntry := widget.NewEntry()
	nameEntry.SetText(initName)
	urlEntry := widget.NewEntry()
	urlEntry.SetText(initURL)

	form := widget.NewForm(
		widget.NewFormItem("Name", nameEntry),
		widget.NewFormItem("Base URL", urlEntry),
	)

	d := dialog.NewCustomConfirm(title, confirmLabel, "Cancel", form, func(ok bool) {
		if !ok {
			return
		}
		name := strings.TrimSpace(nameEntry.Text)
		u    := strings.TrimSpace(urlEntry.Text)
		if name == "" || u == "" {
			return
		}
		onConfirm(name, u)
	}, w)
	d.Resize(fyne.NewSize(520, 250))
	d.Show()
}

func showManageServersDialog(w fyne.Window, onChange func()) {
	var list *widget.List

	// NewBorder objects order: [content, top, bottom, left, right]
	// NewBorder(nil, nil, leftBtns, delBtn, label) → Objects[0]=label [1]=leftBtns [2]=delBtn
	list = widget.NewList(
		func() int { return len(servers) },
		func() fyne.CanvasObject {
			useBtn  := widget.NewButton("Use", nil)
			useBtn.Importance = widget.HighImportance
			editBtn := widget.NewButton("Edit", nil)
			delBtn  := widget.NewButton("Delete", nil)
			delBtn.Importance = widget.DangerImportance
			return container.NewBorder(nil, nil,
				container.NewHBox(useBtn, editBtn), delBtn, widget.NewLabel(""))
		},
		func(i int, o fyne.CanvasObject) {
			border   := o.(*fyne.Container)
			label    := border.Objects[0].(*widget.Label)
			leftBtns := border.Objects[1].(*fyne.Container)
			useBtn   := leftBtns.Objects[0].(*widget.Button)
			editBtn  := leftBtns.Objects[1].(*widget.Button)
			delBtn   := border.Objects[2].(*widget.Button)

			srv       := servers[i]
			isCurrent := currentServer != nil && currentServer.ID == srv.ID

			if isCurrent {
				label.SetText("● " + srv.Name + "  —  " + srv.BaseURL)
				useBtn.Disable()
			} else {
				label.SetText(srv.Name + "  —  " + srv.BaseURL)
				useBtn.Enable()
			}

			useBtn.OnTapped = func() {
				for idx := range servers {
					if servers[idx].ID == srv.ID {
						currentServer    = &servers[idx]
						lastUsedServerID = srv.ID
						break
					}
				}
				saveConfig()
				list.Refresh()
				onChange()
			}

			editBtn.OnTapped = func() {
				showServerForm("Edit Server", "Save", srv.Name, srv.BaseURL,
					func(name, url string) {
						for idx := range servers {
							if servers[idx].ID == srv.ID {
								servers[idx].Name    = name
								servers[idx].BaseURL = url
								if currentServer != nil && currentServer.ID == srv.ID {
									currentServer = &servers[idx]
								}
								break
							}
						}
						saveConfig()
						list.Refresh()
						onChange()
					}, w)
			}

			delBtn.OnTapped = func() {
				dialog.ShowConfirm("Delete Server", "Remove "+srv.Name+"?", func(yes bool) {
					if !yes {
						return
					}
					for idx, s := range servers {
						if s.ID == srv.ID {
							servers = append(servers[:idx], servers[idx+1:]...)
							break
						}
					}
					if currentServer != nil && currentServer.ID == srv.ID {
						if len(servers) > 0 {
							currentServer = &servers[0]
						} else {
							currentServer = nil
						}
					}
					saveConfig()
					list.Refresh()
					onChange()
				}, w)
			}
		},
	)

	addBtn := widget.NewButton("Add New Server", func() {
		showServerForm("Add Server", "Add", "My Server", "http://localhost:11434",
			func(name, url string) {
				servers = append(servers, OllamaServer{
					ID:      strconv.FormatInt(time.Now().UnixNano(), 10),
					Name:    name,
					BaseURL: url,
				})
				currentServer    = &servers[len(servers)-1]
				lastUsedServerID = currentServer.ID
				saveConfig()
				list.Refresh()
				onChange()
			}, w)
	})
	addBtn.Importance = widget.HighImportance

	content := container.NewBorder(nil, container.NewPadded(addBtn), nil, nil, list)
	d := dialog.NewCustom("Manage Servers", "Close", content, w)
	d.Resize(fyne.NewSize(700, 500))
	d.Show()
}
