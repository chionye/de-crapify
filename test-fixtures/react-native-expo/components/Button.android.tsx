import { Pressable, Text, StyleSheet } from 'react-native';

type Props = { label: string; onPress: () => void };

// Android button with ripple feedback
export function PrimaryButton({ label, onPress }: Props) {
  return (
    <Pressable onPress={onPress} android_ripple={{ color: '#ffffff55' }} style={styles.button}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: 4, paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#6200ee' },
  label: { color: 'white', fontWeight: '500' },
});
