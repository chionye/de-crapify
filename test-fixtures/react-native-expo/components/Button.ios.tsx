import { Pressable, Text, StyleSheet } from 'react-native';

type Props = { label: string; onPress: () => void };

// iOS button with a rounded look
export function PrimaryButton({ label, onPress }: Props) {
  return (
    <Pressable onPress={onPress} style={styles.button}>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: 12, paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#007aff' },
  label: { color: 'white', fontWeight: '600' },
});
