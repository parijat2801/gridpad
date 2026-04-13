// LayerPanel — Mantine-based layer management panel.
//
// Shows all non-base layers as a tree (groups with children). A footer row
// shows the base layer (canvas text) when it exists. Toolbar at the top
// provides Group and Ungroup actions.

import { useEffect, useState } from "react";
import {
  Tree,
  Button,
  ActionIcon,
  Menu,
  Text,
  Group,
  Stack,
  Box,
  ScrollArea,
} from "@mantine/core";
import type { TreeNodeData } from "@mantine/core";
import {
  IconSquare,
  IconMinus,
  IconLetterT,
  IconFolder,
  IconEye,
  IconEyeOff,
  IconTrash,
  IconDotsVertical,
  IconFolderPlus,
  IconFolderX,
  IconFileText,
  IconChevronRight,
  IconChevronDown,
} from "@tabler/icons-react";
import { useEditorStore } from "./store";
import { isEffectivelyVisible } from "./layers";
import type { Layer } from "./layers";

// ── Helpers ────────────────────────────────────────────────

function friendlyLabel(l: Layer): string {
  switch (l.type) {
    case "group":
      return l.label ?? "Group";
    case "rect":
      return l.label ?? "Rect";
    case "line":
      return l.label ?? "Line";
    case "text":
      return l.label ?? (l.content ? l.content.slice(0, 20) : "Text");
    case "base":
      return "Canvas text";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Build TreeNodeData[] from layers, skipping base layers. */
function buildTree(layers: Layer[]): TreeNodeData[] {
  // Group children by parentId
  const byParent = new Map<string | null, Layer[]>();
  for (const l of layers) {
    if (l.type === "base") continue;
    const pid = l.parentId ?? null;
    const arr = byParent.get(pid) ?? [];
    arr.push(l);
    byParent.set(pid, arr);
  }
  // Sort each sibling group by z descending (topmost first)
  for (const arr of byParent.values()) {
    arr.sort((a, b) => b.z - a.z);
  }

  function build(parentId: string | null): TreeNodeData[] {
    const children = byParent.get(parentId) ?? [];
    return children.map((l) => ({
      value: l.id,
      label: friendlyLabel(l),
      children: l.type === "group" ? build(l.id) : undefined,
    }));
  }

  return build(null);
}

/** Check whether groupId is a descendant of targetId (to prevent cycles). */
function isDescendantOf(
  groupId: string,
  targetId: string,
  byId: Map<string, Layer>,
): boolean {
  let cur: Layer | undefined = byId.get(groupId);
  while (cur) {
    if (cur.id === targetId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

// ── LayerPanel ─────────────────────────────────────────────

export default function LayerPanel() {
  const layers = useEditorStore((s) => s.layers);
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectLayer = useEditorStore((s) => s.selectLayer);
  const deleteLayer = useEditorStore((s) => s.deleteLayer);
  const toggleVisible = useEditorStore((s) => s.toggleVisible);
  const createGroup = useEditorStore((s) => s.createGroup);
  const ungroup = useEditorStore((s) => s.ungroup);
  const reparentLayer = useEditorStore((s) => s.reparentLayer);

  // Multi-selection pending for grouping (Cmd/Ctrl+click)
  const [pendingSelection, setPendingSelection] = useState<Set<string>>(
    new Set(),
  );

  // Build lookup maps
  const byId = new Map<string, Layer>(layers.map((l) => [l.id, l]));

  // Filter out non-surviving IDs from pendingSelection when layers change
  useEffect(() => {
    const survivingIds = new Set(layers.map((l) => l.id));
    setPendingSelection((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (survivingIds.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [layers]);

  const treeData = buildTree(layers);
  const baseLayer = layers.find((l) => l.type === "base");

  // All group layers (for "Move to group" submenu)
  const groupLayers = layers.filter((l) => l.type === "group");

  // Toolbar state
  const pendingArr = [...pendingSelection];
  const canGroup =
    pendingArr.length >= 2 &&
    pendingArr.every((id) => {
      const l = byId.get(id);
      return l && l.type !== "group" && l.type !== "base";
    }) &&
    // all share the same parentId
    (() => {
      const first = byId.get(pendingArr[0]);
      const firstParent = first?.parentId ?? null;
      return pendingArr.every(
        (id) => (byId.get(id)?.parentId ?? null) === firstParent,
      );
    })();

  const selectedLayer = selectedId ? byId.get(selectedId) : undefined;
  const canUngroup = selectedLayer?.type === "group";

  // ── Row renderer ─────────────────────────────────────────

  function renderNode({
    node,
    expanded,
    hasChildren,
    elementProps,
  }: {
    node: TreeNodeData;
    expanded: boolean;
    hasChildren: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elementProps: Record<string, any>;
  }) {
    const layerId = node.value;
    const layer = byId.get(layerId);
    if (!layer) return null;

    const isSelected = layerId === selectedId;
    const isPending = pendingSelection.has(layerId);
    const effectivelyVisible = isEffectivelyVisible(layer, byId);

    // Determine candidate groups for "Move to" submenu
    const moveToGroups = groupLayers.filter(
      (g) =>
        g.id !== layerId &&
        // avoid cycles: don't move a group into its own descendant
        !isDescendantOf(g.id, layerId, byId),
    );

    function handleRowClick(e: React.MouseEvent) {
      if (e.metaKey || e.ctrlKey) {
        // Toggle in pending selection; do NOT touch store selectedId
        setPendingSelection((prev) => {
          const next = new Set(prev);
          if (next.has(layerId)) {
            next.delete(layerId);
          } else {
            next.add(layerId);
          }
          return next;
        });
      } else {
        selectLayer(layerId);
        setPendingSelection(new Set());
      }
    }

    // Build background/outline styling for selection states
    const rowStyle: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 4,
      padding: "3px 6px",
      borderRadius: 3,
      cursor: "pointer",
      opacity: effectivelyVisible ? 1 : 0.4,
      ...(isSelected
        ? { backgroundColor: "var(--mantine-color-burgundy-6)", color: "#fff" }
        : isPending
          ? {
              outline: "1.5px dashed var(--mantine-color-burgundy-4)",
              outlineOffset: -1,
            }
          : {}),
    };

    // Type icon
    const TypeIcon =
      layer.type === "rect"
        ? IconSquare
        : layer.type === "line"
          ? IconMinus
          : layer.type === "text"
            ? IconLetterT
            : IconFolder; // group

    return (
      <div
        {...elementProps}
        onClick={(e) => {
          // elementProps has its own onClick for Mantine internals (expand etc.)
          // We call it first to handle keyboard/expand, then our own logic.
          elementProps.onClick?.(e);
          handleRowClick(e);
        }}
        style={rowStyle}
      >
        {/* Expand/collapse chevron */}
        <Box style={{ width: 16, flexShrink: 0 }}>
          {hasChildren ? (
            expanded ? (
              <IconChevronDown size={14} />
            ) : (
              <IconChevronRight size={14} />
            )
          ) : null}
        </Box>

        {/* Type icon */}
        <TypeIcon size={14} style={{ flexShrink: 0 }} />

        {/* Label */}
        <Text
          size="xs"
          style={{ flex: 1, minWidth: 0 }}
          truncate
          title={friendlyLabel(layer)}
        >
          {truncate(friendlyLabel(layer), 24)}
        </Text>

        {/* Eye toggle */}
        <ActionIcon
          size="xs"
          variant="subtle"
          onClick={(e) => {
            e.stopPropagation();
            toggleVisible(layerId);
          }}
          title={layer.visible ? "Hide layer" : "Show layer"}
          color={isSelected ? "white" : undefined}
        >
          {layer.visible ? <IconEye size={12} /> : <IconEyeOff size={12} />}
        </ActionIcon>

        {/* Kebab menu */}
        <Menu shadow="md" width={180} withinPortal>
          <Menu.Target>
            <ActionIcon
              size="xs"
              variant="subtle"
              onClick={(e) => e.stopPropagation()}
              title="More options"
              color={isSelected ? "white" : undefined}
            >
              <IconDotsVertical size={12} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
            <Menu.Item
              disabled={layer.parentId == null}
              onClick={(e) => {
                e.stopPropagation();
                reparentLayer(layerId, null);
              }}
            >
              Move to top level
            </Menu.Item>
            {moveToGroups.length > 0 && <Menu.Divider />}
            {moveToGroups.map((g) => (
              <Menu.Item
                key={g.id}
                onClick={(e) => {
                  e.stopPropagation();
                  reparentLayer(layerId, g.id);
                }}
              >
                Move to {truncate(g.label ?? "Group", 20)}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>

        {/* Trash */}
        <ActionIcon
          size="xs"
          variant="subtle"
          color="red"
          onClick={(e) => {
            e.stopPropagation();
            deleteLayer(layerId);
          }}
          title="Delete layer"
        >
          <IconTrash size={12} />
        </ActionIcon>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────

  return (
    <Stack gap={0} style={{ height: "100%", overflow: "hidden" }}>
      {/* Toolbar */}
      <Group gap={6} p={8} style={{ borderBottom: "1px solid #334155" }}>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconFolderPlus size={14} />}
          disabled={!canGroup}
          onClick={() => {
            if (!canGroup) return;
            createGroup([...pendingSelection]);
            setPendingSelection(new Set());
          }}
        >
          Group
        </Button>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconFolderX size={14} />}
          disabled={!canUngroup}
          onClick={() => {
            if (!canUngroup || !selectedId) return;
            ungroup(selectedId);
          }}
        >
          Ungroup
        </Button>
      </Group>

      {/* Layer tree */}
      <ScrollArea style={{ flex: 1 }}>
        <Box p={4}>
          {treeData.length === 0 ? (
            <Text size="xs" c="dimmed" ta="center" mt="md">
              No layers yet
            </Text>
          ) : (
            <Tree
              data={treeData}
              renderNode={renderNode}
              expandOnClick={false}
              selectOnClick={false}
            />
          )}
        </Box>
      </ScrollArea>

      {/* Base layer footer */}
      {baseLayer && (
        <Box
          style={{
            borderTop: "1px solid #334155",
            padding: "4px 10px",
          }}
        >
          <Group gap={4}>
            <IconFileText size={14} style={{ flexShrink: 0 }} />
            <Text size="xs" style={{ flex: 1 }}>
              Canvas text
            </Text>
            <ActionIcon
              size="xs"
              variant="subtle"
              onClick={() => toggleVisible("base")}
              title={baseLayer.visible ? "Hide canvas text" : "Show canvas text"}
            >
              {baseLayer.visible ? (
                <IconEye size={12} />
              ) : (
                <IconEyeOff size={12} />
              )}
            </ActionIcon>
          </Group>
        </Box>
      )}
    </Stack>
  );
}
