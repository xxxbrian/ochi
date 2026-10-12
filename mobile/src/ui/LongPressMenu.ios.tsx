import { Fragment, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ContextMenu, Divider, Host, RNHostView, type ButtonProps } from '@expo/ui/swift-ui';
import { accessibilityAddTraits, accessibilityElement, accessibilityLabel, buttonStyle, contentShape, disabled, frame, shapes } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../providers/AppProvider';
import type { LongPressMenuProps } from './LongPressMenu';

const symbols: Record<string, ButtonProps['systemImage']> = {
  copy: 'doc.on.doc', edit: 'pencil', rename: 'pencil', delete: 'trash', share: 'square.and.arrow.up',
};

export function LongPressMenu({ items, children, preview, label, onPress, style, previewRadius = 20, selected }: LongPressMenuProps) {
  const { dark, colors } = useTheme();
  const [size, setSize] = useState<{ width: number; height: number }>();
  const nativeLabel = size ? <RNHostView matchContents><View pointerEvents="none" style={{ width: size.width }}>{children}</View></RNHostView> : undefined;
  return <View style={[styles.measure, style]} onLayout={(event) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0 && (size?.width !== width || size.height !== height)) setSize({ width, height });
  }}>
    {/* Yoga keeps text wrapping and responsive intrinsic sizing; SwiftUI receives finite bounds. */}
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={size && styles.hidden}>
      {children}
    </View>
    {size && <Host matchContents={false} ignoreSafeArea="all" colorScheme={dark ? 'dark' : 'light'} seedColor={colors.text} style={StyleSheet.absoluteFill}>
      <ContextMenu modifiers={[
        contentShape(shapes.roundedRectangle({ cornerRadius: previewRadius }), ['interaction', 'contextMenuPreview']),
        ...(!onPress ? [accessibilityElement('combine'), ...(label ? [accessibilityLabel(label)] : [])] : []),
      ]}>
        <ContextMenu.Trigger>
          {/* ContextMenu does not forward modifier event listeners; Button owns the native tap action. */}
          {onPress ? <Button onPress={onPress} modifiers={[
            buttonStyle('plain'), frame({ width: size.width, height: size.height }),
            contentShape(shapes.roundedRectangle({ cornerRadius: previewRadius })),
            accessibilityElement('combine'),
            ...(label ? [accessibilityLabel(label)] : []),
            accessibilityAddTraits(selected ? ['isButton', 'isSelected'] : ['isButton']),
          ]}>{nativeLabel}</Button> : nativeLabel}
        </ContextMenu.Trigger>
        {/* RNHostView's automatic snapshot can be empty; SwiftUI owns the explicit preview's lift and dimming. */}
        <ContextMenu.Preview><RNHostView matchContents>
          <View style={{ width: size.width }}>{preview ?? children}</View>
        </RNHostView></ContextMenu.Preview>
        <ContextMenu.Items>
          {items.map((item) => <Fragment key={item.key}>
            {item.separatorBefore && <Divider />}
            <Button label={item.title ?? item.label} systemImage={item.selected ? 'checkmark' : symbols[item.key]}
              role={item.danger ? 'destructive' : undefined} modifiers={[disabled(Boolean(item.disabled))]} onPress={item.onPress} />
          </Fragment>)}
        </ContextMenu.Items>
      </ContextMenu>
    </Host>}
  </View>;
}

const styles = StyleSheet.create({ measure: { maxWidth: '100%' }, hidden: { opacity: 0 } });
