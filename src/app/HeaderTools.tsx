import type { ReactNode } from "react";
import { MenuIcons } from "../context-menu/menuIcons";
import { PluginUsageButton } from "../plugins/PluginUsageButton";
import { pluginIconNode } from "../plugins/icons";
import { FavoritesButton } from "../favorites/FavoritesButton";
import type { SidebarMode } from "../settings/modes";
import { Icons } from "./icons";
import type { ShellCtx } from "./shellContext";
import { moreMenuItems } from "./moreMenu";

export function renderHeaderTools(S: ShellCtx): { sidebarToggle: ReactNode; headerTools: ReactNode } {
  const {
    activeAgent, activeTerminal, agentPinned, agentPopoverOpen, allPlugins, favoritesButtonVisible, gitChangeCount,
    openFavorite, openMenu, panelLayout, pluginBtnRef, quickActionIds, quickActionReorder, runPlugin,
    setPluginMenuAnchor, setSidebarMode, shellId, sidebarCollapsed, sidebarMode, sidebarTab, sidebarVisible, t,
    tabShell, togglePanel, toggleQuickAction,
  } = S;
  // The header's panel toggles and tools: in the header when wide, on a row of their own below the terminal when narrow.
  const sidebarToggle = (
    <button
      className={"icon-button" + (!sidebarCollapsed ? " is-active" : "") + (panelLayout.parked.sidebar ? " is-parked" : "")}
      aria-pressed={!sidebarCollapsed}
      onClick={() => togglePanel("sidebar")}
      onContextMenu={(e) =>
        openMenu(
          e,
          (
            [
              ["auto", t("sidebarMode.auto")],
              ["docked", t("sidebarMode.docked")],
              ["floating", t("sidebarMode.floating")],
            ] as [SidebarMode, string][]
          ).map(([m, label]) => ({
            label,
            icon: m === "auto" ? MenuIcons.sidebarAuto : m === "docked" ? MenuIcons.sidebarDocked : MenuIcons.sidebarFloating,
            checked: sidebarMode === m,
            onSelect: () => setSidebarMode(m),
          })),
        )
      }
      aria-label={t("app.toggleSidebar")}
      title={sidebarCollapsed && gitChangeCount > 0 ? t("app.toggleSidebar.titleChanges", { count: gitChangeCount }) : t("app.toggleSidebar.title")}
    >
      <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <path d="M9.5 4.5v15" />
        {sidebarVisible && <path className="sidebar-toggle-fill" d="M6 4.5h3.5v15H6a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 6 4.5z" />}
      </svg>
      {sidebarCollapsed && gitChangeCount > 0 && <span className="sidebar-toggle-dot" aria-hidden="true" />}
    </button>
  );

  const headerTools = (
    <>
      {quickActionIds.length > 0 && (
        <div
          className={"quick-actions" + (quickActionReorder.draggingId ? " is-reordering" : "")}
          aria-label={t("app.reorderShortcuts")}
          onClickCapture={quickActionReorder.onClickCapture}
          onDragStart={(e) => e.preventDefault()}
        >
          {quickActionReorder.ids.map((id) => {
            const plugin = allPlugins.find((p) => p.id === id);
            if (!plugin) return null;
            return (
              <div
                key={id}
                data-shortcut-id={id}
                className={"quick-action" + (quickActionReorder.draggingId === id ? " is-dragging" : "") + (quickActionReorder.pressingId === id ? " is-pressing" : "")}
                onPointerDown={(e) => quickActionReorder.onPointerDown(e, id)}
                onContextMenu={(e) => {
                  if (quickActionReorder.draggingId) e.preventDefault();
                  else openMenu(e, [{ label: t("app.removeShortcut"), icon: MenuIcons.trash, danger: true, onSelect: () => toggleQuickAction(id) }]);
                }}
              >
                <PluginUsageButton
                  plugin={plugin}
                  icon={pluginIconNode(plugin)}
                  active={
                    plugin.action === "toggleAgentsSidebar"
                      ? agentPinned
                        ? sidebarVisible && sidebarTab === "agent" && !!activeAgent
                        : agentPopoverOpen && !!activeAgent
                      : undefined
                  }
                  parked={
                    (plugin.action === "toggleBrowser" && panelLayout.parked.browser) ||
                    (plugin.action === "toggleSidebar" && panelLayout.parked.sidebar)
                  }
                  onRun={() => runPlugin(plugin)}
                />
              </div>
            );
          })}
        </div>
      )}
      {favoritesButtonVisible && (
        <FavoritesButton
          activeCwd={activeTerminal && !activeTerminal.busy ? activeTerminal.cwd || undefined : undefined}
          activeShell={activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined}
          onOpenFolder={openFavorite}
        />
      )}
      <button
        ref={pluginBtnRef}
        type="button"
        className="icon-button"
        onClick={() => setPluginMenuAnchor((r) => (r ? null : pluginBtnRef.current?.getBoundingClientRect() ?? null))}
        aria-label={t("settings.section.features")}
        title={t("settings.section.features")}
      >
        {Icons.features}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t("app.moreOptions")}
        title={t("app.moreOptions")}
        data-host-menu-anchor
        onClick={(e) => openMenu(e, moreMenuItems(S))}
      >
        {Icons.kebab}
      </button>
    </>
  );
  return { sidebarToggle, headerTools };
}
