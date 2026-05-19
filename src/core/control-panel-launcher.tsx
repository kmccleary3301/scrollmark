import { ScrollmarkIcon } from '@/components/scrollmark-icon';

type ControlPanelLauncherProps = {
  currentTheme: string;
  onToggle: () => void;
};

export function ControlPanelLauncher({ currentTheme, onToggle }: ControlPanelLauncherProps) {
  return (
    <div
      onClick={onToggle}
      data-theme={currentTheme}
      class="group w-12 h-12 fixed top-[60%] left-[-20px] cursor-pointer bg-transparent text-base-content"
    >
      <div class="w-full h-full origin origin-[bottom_center] transition-all duration-200 group-hover:translate-x-[5px] group-hover:rotate-[20deg] opacity-50 group-hover:opacity-90">
        <ScrollmarkIcon class="h-full w-full" />
      </div>
    </div>
  );
}
