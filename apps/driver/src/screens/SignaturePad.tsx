import { useRef, useState } from 'react';
import { PanResponder, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { Stroke } from '../png';
import { colors } from '../ui';

/** The recipient signs with a finger; the strokes are turned into a PNG when the step is saved. */
export function SignaturePad({
  strokes,
  onChange,
  height = 180,
}: {
  strokes: Stroke[];
  onChange(s: Stroke[], box: { w: number; h: number }): void;
  height?: number;
}) {
  const [width, setWidth] = useState(300);
  const current = useRef<Stroke>([]);
  const all = useRef<Stroke[]>(strokes);
  all.current = strokes;
  const [, force] = useState(0);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        current.current = [{ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
        force((n) => n + 1);
      },
      onPanResponderMove: (e) => {
        current.current.push({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
        force((n) => n + 1);
      },
      onPanResponderRelease: () => {
        if (current.current.length)
          onChange([...all.current, current.current], { w: widthRef.current, h: height });
        current.current = [];
      },
    }),
  ).current;
  const widthRef = useRef(width);
  const path = (st: Stroke) =>
    st.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return (
    <View
      onLayout={(e: LayoutChangeEvent) => {
        setWidth(e.nativeEvent.layout.width);
        widthRef.current = e.nativeEvent.layout.width;
      }}
      style={{
        height,
        borderWidth: 1,
        borderColor: '#cbd5e1',
        borderRadius: 12,
        backgroundColor: '#fff',
        overflow: 'hidden',
      }}
      {...responder.panHandlers}
    >
      <Svg width={width} height={height} pointerEvents="none">
        {[...strokes, current.current].map((st, i) =>
          st.length ? (
            <Path
              key={i}
              d={path(st)}
              stroke={colors.ink}
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null,
        )}
      </Svg>
    </View>
  );
}
