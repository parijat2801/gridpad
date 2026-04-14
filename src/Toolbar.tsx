import { ActionIcon, Group, Tooltip, Divider } from "@mantine/core";
import {
  IconPointer, IconSquare, IconMinus, IconLetterT,
  IconEraser, IconFileUpload, IconDeviceFloppy, IconRefresh,
} from "@tabler/icons-react";
import { useEditorStore } from "./store";

const TOOLS = [
  { id: "select", icon: IconPointer, label: "Select (V)" },
  { id: "rect", icon: IconSquare, label: "Rectangle (R)" },
  { id: "line", icon: IconMinus, label: "Line (L)" },
  { id: "text", icon: IconLetterT, label: "Text (T)" },
  { id: "eraser", icon: IconEraser, label: "Eraser (E)" },
] as const;

export function Toolbar({
  onOpen,
  onSave,
  onReload,
}: {
  onOpen: () => void;
  onSave: () => void;
  onReload: () => void;
}) {
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);

  return (
    <Group gap="xs" p="xs" style={{ borderBottom: "1px solid #334155" }}>
      <Tooltip label="Open file (Cmd+O)" position="bottom">
        <ActionIcon variant="subtle" color="gray" size="lg" onClick={onOpen} aria-label="Open file">
          <IconFileUpload size={20} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Save file (Cmd+S)" position="bottom">
        <ActionIcon variant="subtle" color="gray" size="lg" onClick={onSave} aria-label="Save file">
          <IconDeviceFloppy size={20} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Reload file (Cmd+Shift+R)" position="bottom">
        <ActionIcon variant="subtle" color="gray" size="lg" onClick={onReload} aria-label="Reload file">
          <IconRefresh size={20} />
        </ActionIcon>
      </Tooltip>
      <Divider orientation="vertical" />
      {TOOLS.map(({ id, icon: Icon, label }) => (
        <Tooltip key={id} label={label} position="bottom">
          <ActionIcon
            variant={activeTool === id ? "filled" : "subtle"}
            color={activeTool === id ? "burgundy" : "gray"}
            size="lg"
            onClick={() => setActiveTool(id)}
            aria-label={label}
            aria-pressed={activeTool === id}
          >
            <Icon size={20} />
          </ActionIcon>
        </Tooltip>
      ))}
    </Group>
  );
}
