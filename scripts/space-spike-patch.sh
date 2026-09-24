#!/usr/bin/env bash
# P7-C 宿主形态 spike 补丁：把三种"全窗口覆盖层"的占位实现打进 Chromium 树。
#
#   形态 (i)  view   —— BrowserView 的子 View（同一窗口，最后添加 = 最上层）
#   形态 (ii) widget —— 浏览器 widget 的子 Widget（独立子 NSWindow，天然置顶）
#   形态 (iii)window —— 独立无 chrome 窗口
#
# 内容 = 真实的 views::WebView（加载 /tmp/space-spike.html）——因为最终形态就是
# WebUI，而且纯 View 在 macOS 上盖不住原生 web 内容（实测）。
#
# 用法：bash space-spike-patch.sh          # 打补丁
#       bash space-spike-patch.sh --revert # 撤销（逐行按 marker 精确恢复）
#
# 幂等：重复打补丁不会重复插入；revert 后文件与原始状态逐字节一致（已自测）。
set -euo pipefail

SRC="${SRC:-/Volumes/SN850X_2T/hub-browser/src}"
FRAME="$SRC/chrome/browser/ui/views/frame"
BUILD_GN="$SRC/chrome/browser/ui/BUILD.gn"
BROWSER_VIEW_CC="$FRAME/browser_view.cc"
NEW_CC="$FRAME/space_spike_overlay.cc"
NEW_H="$FRAME/space_spike_overlay.h"
HTML="/tmp/space-spike.html"
MARKER="space_spike_overlay"

REVERT=0
[ "${1:-}" = "--revert" ] && REVERT=1

for f in "$BUILD_GN" "$BROWSER_VIEW_CC"; do
  [ -f "$f" ] || { echo "✗ 找不到 $f" >&2; exit 1; }
done

if [ "$REVERT" = "1" ]; then
  echo "→ 撤销 spike 补丁"
  rm -f "$NEW_CC" "$NEW_H"
  python3 - "$BUILD_GN" "$BROWSER_VIEW_CC" <<'PY'
import sys
build_gn, bv = sys.argv[1], sys.argv[2]

def drop_lines(path, pred):
    with open(path) as f:
        lines = f.readlines()
    kept = [l for l in lines if not pred(l)]
    if len(kept) != len(lines):
        with open(path, 'w') as f:
            f.writelines(kept)
    return len(lines) - len(kept)

n1 = drop_lines(build_gn, lambda l: 'views/frame/space_spike_overlay' in l)
# 我插入的每一行都带 marker（含注释），所以按行删就等价于精确还原。
n2 = drop_lines(bv, lambda l: ('space_spike' in l) or ('space-spike' in l)
                              or ('P7-C host-form spike' in l))
print(f"  BUILD.gn -{n1} 行, browser_view.cc -{n2} 行")
PY
  echo "✓ 已撤销（未重编；如需生效请重新编译）"
  exit 0
fi

echo "→ 写入 spike 页面 $HTML"
cat > "$HTML" <<'HTMLEOF'
<!doctype html>
<meta charset="utf-8">
<title>space spike</title>
<style>
  html,body{margin:0;height:100%;}
  body{
    background:#F7F1E4;border:6px solid #E8A33D;box-sizing:border-box;
    font:16px/1.6 -apple-system,"PingFang SC",sans-serif;color:#1F1D19;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:14px;text-align:center;
  }
  h1{font-size:30px;margin:0;letter-spacing:.5px}
  button{font-size:16px;padding:10px 18px;border-radius:999px;border:0;
         background:#14120F;color:#fff;cursor:pointer}
  .corner{position:fixed;font:600 13px/1 -apple-system,"PingFang SC",sans-serif;
          color:#6B6459;background:#FBEBD2;border-radius:999px;padding:6px 10px}
  #tl{top:10px;left:10px} #tr{top:10px;right:10px}
  #bl{bottom:10px;left:10px} #br{bottom:10px;right:10px}
  .hint{font-size:13px;color:#6B6459}
</style>
<div class="corner" id="tl">左上</div>
<div class="corner" id="tr">右上</div>
<div class="corner" id="bl">左下</div>
<div class="corner" id="br">右下</div>
<h1 id="t">SPACE SPIKE</h1>
<p>四个角都看到「左上/右上/左下/右下」= 这一层盖住了整个窗口。</p>
<p>输入屏障：点下面的按钮（应该点得到），再点按钮以外的区域 —— 下面的网页不该有任何反应。</p>
<button id="b">点我 —— 点得到说明这一层吃掉了输入</button>
<p id="c">点击次数：0</p>
<p class="hint">切换形态：退出 app 后跑 hub-browser/scripts/space-spike.sh view|widget|window</p>
<script>
  const form = new URLSearchParams(location.search).get('form') || '(unknown)';
  document.getElementById('t').textContent = 'SPACE SPIKE   host form = ' + form;
  document.title = 'space-spike:' + form;
  let n = 0;
  document.getElementById('b').onclick = () => {
    n++; document.getElementById('c').textContent = '点击次数：' + n;
  };
</script>
HTMLEOF

echo "→ 写入新文件 $NEW_CC / $NEW_H"
cat > "$NEW_H" <<'EOF'
// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_VIEWS_FRAME_SPACE_SPIKE_OVERLAY_H_
#define CHROME_BROWSER_UI_VIEWS_FRAME_SPACE_SPIKE_OVERLAY_H_

class BrowserView;

namespace space_spike {

// P7-C host-form spike (docs/specs/space-ui-and-model.md 8.3).
//
// Reads --space-spike=view|widget|window (also accepts i|ii|iii) and installs a
// placeholder full-window overlay using the requested host form, so the three
// candidate hosts can be compared on a real browser window:
//
//   view   -> a child View of BrowserView (same window, painted last = on top)
//   widget -> a child views::Widget of the browser widget (its own NSWindow)
//   window -> a standalone frameless window
//
// The content is a real views::WebView (loading file:///tmp/space-spike.html),
// because that is what the real space UI will be, and because a plain View
// cannot paint above the native web contents on macOS.
//
// No-op when the switch is absent or unknown.
void MaybeInstall(BrowserView* browser_view);

// Keeps an already installed overlay sized to the whole window. Called from
// BrowserView::Layout(), because at install time (AddedToWidget) the window
// still has no bounds, so the first sizing has to come from a later layout.
void UpdateBoundsFor(BrowserView* browser_view);

}  // namespace space_spike

#endif  // CHROME_BROWSER_UI_VIEWS_FRAME_SPACE_SPIKE_OVERLAY_H_
EOF

cat > "$NEW_CC" <<'EOF'
// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/views/frame/space_spike_overlay.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/strings/utf_string_conversions.h"
#include "base/timer/timer.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/views/background.h"
#include "ui/views/border.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/layout/box_layout_view.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_observer.h"
#include "url/gurl.h"

namespace space_spike {
namespace {

// Command line switch selecting the host form.
constexpr char kSwitchName[] = "space-spike";
constexpr char kSpikeUrl[] = "file:///tmp/space-spike.html";

// LOG(INFO) is compiled out of official builds, so diagnostics use LOG(ERROR).
#define SPACE_SPIKE_LOG(expr) LOG(ERROR) << "[space-spike] " << expr

// Cheap non-WebView cover used inside the macOS immersive-fullscreen overlay
// widgets. In immersive fullscreen Chromium reparents the top container into
// `BrowserView::overlay_widget()` — a *child NSWindow* — which always draws
// above every BrowserView child, so a BrowserView-level overlay can never cover
// the toolbar there. This view lives inside that child window instead.
class SpaceSpikeCoverView : public views::BoxLayoutView {
 public:
  explicit SpaceSpikeCoverView(const std::string& form) {
    SetBackground(
        views::CreateSolidBackground(SkColorSetARGB(0xE6, 0xF7, 0xF1, 0xE4)));
    SetBorder(views::CreateSolidBorder(6, SkColorSetRGB(0xE8, 0xA3, 0x3D)));
    SetOrientation(views::BoxLayout::Orientation::kVertical);
    SetMainAxisAlignment(views::BoxLayout::MainAxisAlignment::kCenter);
    SetCrossAxisAlignment(views::BoxLayout::CrossAxisAlignment::kCenter);
    auto* label = AddChildView(std::make_unique<views::Label>(
        base::UTF8ToUTF16("SPACE SPIKE   fullscreen cover   form = " + form)));
    label->SetEnabledColor(SkColorSetRGB(0x1F, 0x1D, 0x19));
  }

  SpaceSpikeCoverView(const SpaceSpikeCoverView&) = delete;
  SpaceSpikeCoverView& operator=(const SpaceSpikeCoverView&) = delete;
  ~SpaceSpikeCoverView() override = default;
};

// Installs one overlay. Owns nothing: the overlay View is owned by
// BrowserView's child list and the widgets are owned by their native windows
// (NATIVE_WIDGET_OWNS_WIDGET), so this object only forwards bounds changes.
class SpaceSpikeHost : public views::WidgetObserver {
 public:
  SpaceSpikeHost(BrowserView* browser_view, const std::string& form)
      : browser_view_(browser_view), form_(form) {}

  SpaceSpikeHost(const SpaceSpikeHost&) = delete;
  SpaceSpikeHost& operator=(const SpaceSpikeHost&) = delete;
  ~SpaceSpikeHost() override = default;

  void Install() {
    std::unique_ptr<views::View> content = CreateContent();
    if (form_ == "view") {
      overlay_view_ = browser_view_->AddChildView(std::move(content));
      browser_view_->GetWidget()->AddObserver(this);
      UpdateBounds();
    } else if (form_ == "widget") {
      widget_ = CreateWidget(/*as_child=*/true, std::move(content));
      browser_view_->GetWidget()->AddObserver(this);
      UpdateBounds();
    } else {
      widget_ = CreateWidget(/*as_child=*/false, std::move(content));
      widget_->SetBounds(browser_view_->GetWidget()->GetWindowBoundsInScreen());
      widget_->Show();
      widget_->Activate();
    }
    SPACE_SPIKE_LOG("installed form=" << form_ << " overlay=" << overlay_view_
                                      << " widget=" << widget_);
    // Also watch the immersive-fullscreen overlay widget: it is the one that
    // gets sized when fullscreen starts (and it may be 1x1 while the transition
    // is still running), so the fullscreen cover has to follow it.
    if (views::Widget* overlay = browser_view_->overlay_widget()) {
      overlay->AddObserver(this);
    }
    LogGeometry();
  }

  BrowserView* browser_view() const { return browser_view_; }

  // Keeps the overlay covering the whole window. Called on every
  // BrowserView::Layout() and on browser widget bounds changes.
  void UpdateBounds() {
    UpdateFullscreenCover();
    if (overlay_view_) {
      const gfx::Rect target(browser_view_->GetLocalBounds().size());
      if (overlay_view_->bounds() != target) {
        overlay_view_->SetBoundsRect(target);
        SPACE_SPIKE_LOG("overlay bounds -> " << target.ToString());
        LogGeometry();
      }
      return;
    }
    if (widget_) {
      widget_->SetBounds(browser_view_->GetWidget()->GetWindowBoundsInScreen());
    }
  }

  // views::WidgetObserver:
  void OnWidgetDestroying(views::Widget* widget) override { dead_ = true; }
  void OnWidgetBoundsChanged(views::Widget* widget,
                             const gfx::Rect& new_bounds) override {
    if (dead_) {
      return;
    }
    if (widget == browser_view_->GetWidget()) {
      const gfx::Size size = new_bounds.size();
      if (size != last_window_size_) {
        last_window_size_ = size;
        // Live resize: hide the overlay while the user is still dragging. The
        // browser scales its last frame during a live resize, but the overlay's
        // WebView re-lays-out asynchronously, which shows up as smearing and
        // makes the whole window feel slow. Restore once the drag settles.
        SetOverlayVisible(false);
        resize_timer_.Start(
            FROM_HERE, base::Milliseconds(160),
            base::BindOnce(&SpaceSpikeHost::OnResizeSettled,
                           base::Unretained(this)));
      }
    }
    UpdateBounds();
  }

 private:
  void OnResizeSettled() {
    if (dead_) {
      return;
    }
    UpdateBounds();
    SetOverlayVisible(true);
  }

  void SetOverlayVisible(bool visible) {
    if (overlay_view_) {
      overlay_view_->SetVisible(visible);
    }
    if (widget_) {
      widget_->SetVisible(visible);
    }
  }

  // macOS immersive fullscreen reparents the top container into
  // `overlay_widget_` — a child NSWindow that always draws above every
  // BrowserView child — so a BrowserView-level overlay can never cover the
  // toolbar there. Measured: that widget's contents view stays 1x1 in the Views
  // tree (the NSWindow is sized by AppKit), so putting a cover *inside* it does
  // not work. Instead hide those child windows while our overlay is up: the
  // strip then shows the main overlay underneath, which is exactly the design
  // intent (overview / agent mask must not show browser chrome).
  void UpdateImmersiveOverlayVisibility() {
    const bool should_hide = browser_view_->IsFullscreen() && IsOverlayShown();
    HideOrRestore(browser_view_->overlay_widget(), should_hide,
                  &hid_overlay_widget_);
    HideOrRestore(browser_view_->tab_overlay_widget(), should_hide,
                  &hid_tab_overlay_widget_);
  }

  // Note: in immersive fullscreen these widgets' NSWindows are ordered by
  // AppKit, and `Widget::IsVisible()` can report false while the window is on
  // screen — so do not gate Hide() on IsVisible(); track our own flag instead.
  void HideOrRestore(views::Widget* widget, bool should_hide, bool* hid) {
    if (!widget) {
      return;
    }
    if (should_hide) {
      if (!*hid) {
        widget->Hide();
        *hid = true;
        SPACE_SPIKE_LOG("hid immersive overlay widget " << widget->GetName());
      }
    } else if (*hid) {
      widget->ShowInactive();
      *hid = false;
      SPACE_SPIKE_LOG("restored immersive overlay widget " << widget->GetName());
    }
  }

  bool IsOverlayShown() const {
    if (overlay_view_) {
      return overlay_view_->GetVisible();
    }
    if (widget_) {
      return widget_->IsVisible();
    }
    return false;
  }

  std::unique_ptr<views::View> CreateContent() {
    auto web_view =
        std::make_unique<views::WebView>(browser_view_->browser()->profile());
    web_view->LoadInitialURL(
        GURL(std::string(kSpikeUrl) + "?form=" + form_));
    return web_view;
  }

  void LogGeometry() {
    std::string overlay_screen = "n/a";
    if (overlay_view_) {
      overlay_screen = overlay_view_->GetBoundsInScreen().ToString();
    } else if (widget_) {
      overlay_screen = widget_->GetWindowBoundsInScreen().ToString();
    }
    SPACE_SPIKE_LOG(
        "geometry: browser_view local="
        << browser_view_->GetLocalBounds().ToString()
        << " screen=" << browser_view_->GetBoundsInScreen().ToString()
        << " window_screen="
        << browser_view_->GetWidget()->GetWindowBoundsInScreen().ToString()
        << " overlay_screen=" << overlay_screen);
  }

  views::Widget* CreateWidget(bool as_child,
                              std::unique_ptr<views::View> content) {
    views::Widget::InitParams params(
        views::Widget::InitParams::NATIVE_WIDGET_OWNS_WIDGET,
        as_child ? views::Widget::InitParams::TYPE_POPUP
                 : views::Widget::InitParams::TYPE_WINDOW_FRAMELESS);
    if (as_child) {
      params.child = true;
      params.parent = browser_view_->GetWidget()->GetNativeView();
      params.shadow_type = views::Widget::InitParams::ShadowType::kNone;
      params.activatable = views::Widget::InitParams::Activatable::kNo;
      params.is_overlay = true;
      params.opacity = views::Widget::InitParams::WindowOpacity::kTranslucent;
      params.name = "space-spike-child-widget";
    } else {
      params.shadow_type = views::Widget::InitParams::ShadowType::kDrop;
      params.name = "space-spike-window";
    }

    auto* widget = new views::Widget();
    widget->Init(std::move(params));
    widget->SetContentsView(std::move(content));
    if (as_child) {
      widget->Show();
    }
    return widget;
  }

  const raw_ptr<BrowserView> browser_view_;
  const std::string form_;
  raw_ptr<views::View> overlay_view_ = nullptr;
  raw_ptr<views::Widget> widget_ = nullptr;
  raw_ptr<views::View> cover_view_ = nullptr;
  base::OneShotTimer resize_timer_;
  gfx::Size last_window_size_;
  bool dead_ = false;
};

// Intentionally never destroyed: these only observe widgets and must not run
// destructors while the browser is shutting down.
std::vector<SpaceSpikeHost*>& Hosts() {
  static std::vector<SpaceSpikeHost*>* hosts =
      new std::vector<SpaceSpikeHost*>();
  return *hosts;
}

// Forms (ii)/(iii) install only in the first normal window, so the user does
// not get one overlay per window. Form (i) is naturally per window.
bool g_installed_once = false;

std::string NormalizeForm(const std::string& value) {
  if (value == "i" || value == "1" || value == "view") {
    return "view";
  }
  if (value == "ii" || value == "2" || value == "widget") {
    return "widget";
  }
  if (value == "iii" || value == "3" || value == "window") {
    return "window";
  }
  return std::string();
}

}  // namespace

void MaybeInstall(BrowserView* browser_view) {
  const base::CommandLine* command_line =
      base::CommandLine::ForCurrentProcess();
  if (!command_line->HasSwitch(kSwitchName)) {
    return;
  }
  const std::string raw = command_line->GetSwitchValueASCII(kSwitchName);
  const std::string form = NormalizeForm(raw);
  if (form.empty()) {
    SPACE_SPIKE_LOG("unknown --space-spike value: " << raw);
    return;
  }
  if (!browser_view->browser() || !browser_view->browser()->is_type_normal()) {
    SPACE_SPIKE_LOG("skipped: not a normal browser window");
    return;
  }
  if (form != "view" && g_installed_once) {
    return;
  }
  g_installed_once = true;

  auto* host = new SpaceSpikeHost(browser_view, form);
  Hosts().push_back(host);
  host->Install();
}

void UpdateBoundsFor(BrowserView* browser_view) {
  for (SpaceSpikeHost* host : Hosts()) {
    if (host->browser_view() == browser_view) {
      host->UpdateBounds();
    }
  }
}

}  // namespace space_spike
EOF

echo "→ 改 BUILD.gn（加两个源文件）"
python3 - "$BUILD_GN" "$MARKER" <<'PY'
import sys
path, marker = sys.argv[1], sys.argv[2]
with open(path) as f:
    src = f.read()
if marker in src:
    print("  已存在，跳过")
    sys.exit(0)
anchor = '      "views/frame/browser_view.h",\n'
if anchor not in src:
    print("✗ BUILD.gn 锚点找不到", file=sys.stderr)
    sys.exit(1)
add = ('      "views/frame/space_spike_overlay.cc",\n'
       '      "views/frame/space_spike_overlay.h",\n')
with open(path, 'w') as f:
    f.write(src.replace(anchor, anchor + add, 1))
print("  +2 行")
PY

echo "→ 改 browser_view.cc（include + AddedToWidget 挂载 + Layout 保尺寸）"
python3 - "$BROWSER_VIEW_CC" "$MARKER" <<'PY'
import sys
path, marker = sys.argv[1], sys.argv[2]
with open(path) as f:
    src = f.read()
if marker in src:
    print("  已存在，跳过")
    sys.exit(0)

# 1) include
inc_anchor = '#include "chrome/browser/ui/views/frame/browser_view.h"\n'
inc_add = '#include "chrome/browser/ui/views/frame/space_spike_overlay.h"\n'
if inc_anchor not in src:
    print("✗ include 锚点找不到", file=sys.stderr)
    sys.exit(1)
src = src.replace(inc_anchor, inc_anchor + inc_add, 1)

# 2) 挂载点必须是 AddedToWidget()：BrowserView::GetWidget() 在构造函数期间还是
#    nullptr（widget 由 browser_window_factory 构造完才挂上），早挂会空指针崩。
call_anchor = ('  dialog_anchor_ = std::make_unique<views::ViewSubregionAnchor>(\n'
               '      kBrowserDialogAnchorElementId, *this);\n'
               '\n'
               '  initialized_ = true;\n'
               '}\n')
call_add = ('  dialog_anchor_ = std::make_unique<views::ViewSubregionAnchor>(\n'
            '      kBrowserDialogAnchorElementId, *this);\n'
            '\n'
            '  // P7-C host-form spike (space_spike_overlay.h): no-op unless\n'
            '  // --space-spike=<form> was passed. This runs in AddedToWidget\n'
            '  // rather than the constructor because space_spike needs a valid\n'
            '  // GetWidget(): space_spike must not run before the view is in a widget.\n'
            '  space_spike::MaybeInstall(this);\n'
            '  initialized_ = true;\n'
            '}\n')
if call_anchor not in src:
    print("✗ AddedToWidget 末尾锚点找不到", file=sys.stderr)
    sys.exit(1)
src = src.replace(call_anchor, call_add, 1)

# 3) 挂载那一刻窗口还没有 bounds，overlay 的尺寸要在每次 Layout() 时重申。
layout_anchor = '  LayoutSuperclass<views::View>(this);\n'
layout_add = ('  LayoutSuperclass<views::View>(this);\n'
              '  // P7-C host-form spike: space_spike::UpdateBoundsFor keeps the\n'
              '  // space_spike overlay covering the whole window.\n'
              '  space_spike::UpdateBoundsFor(this);\n')
if layout_anchor not in src:
    print("✗ Layout 锚点找不到", file=sys.stderr)
    sys.exit(1)
src = src.replace(layout_anchor, layout_add, 1)

with open(path, 'w') as f:
    f.write(src)
print("  +13 行")
PY

echo
echo "✓ 补丁已打入。改动："
echo "  新增  $NEW_CC"
echo "  新增  $NEW_H"
echo "  新增  ${HTML}  (spike 页面内容)"
echo "  修改  chrome/browser/ui/BUILD.gn"
echo "  修改  chrome/browser/ui/views/frame/browser_view.cc"
