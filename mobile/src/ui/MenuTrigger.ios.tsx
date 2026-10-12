import { Fragment, type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import { Button, Divider, Host, Menu, RNHostView, type ButtonProps } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonStyle, disabled, menuIndicator, menuStyle } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../providers/AppProvider';
import type { MenuItem } from './AnchoredMenu';

export type MenuTriggerProps = { items: MenuItem[]; children: ReactNode; style?: ViewStyle; label?: string };

const symbols: Record<string, ButtonProps['systemImage']> = {
  camera: 'camera', photos: 'photo.on.rectangle', files: 'doc', settings: 'gearshape',
  rename: 'pencil', delete: 'trash', share: 'square.and.arrow.up', admin: 'shield',
  signout: 'rectangle.portrait.and.arrow.right', computer: 'desktopcomputer',
};

export function MenuTrigger({ items, children, style, label }: MenuTriggerProps) {
  const { dark, colors } = useTheme();
  return (
    <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.text} matchContents style={style}>
      <Menu modifiers={[menuStyle('button'), buttonStyle('plain'), menuIndicator('hidden'), ...(label ? [accessibilityLabel(label)] : [])]} label={<RNHostView matchContents><View>{children}</View></RNHostView>}>
        {items.map((item) => <Fragment key={item.key}>
          {item.separatorBefore && <Divider />}
          <Button label={item.title ?? item.label} systemImage={item.selected ? 'checkmark' : symbols[item.key]}
            role={item.danger ? 'destructive' : undefined} modifiers={[disabled(Boolean(item.disabled))]} onPress={item.onPress} />
        </Fragment>)}
      </Menu>
    </Host>
  );
}
