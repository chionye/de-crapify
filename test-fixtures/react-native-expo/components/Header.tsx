import { Text, View, StyleSheet } from 'react-native';
import { theme } from '@/lib/theme';

export default function Header({ title }: { title: string }) {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { padding: 16, backgroundColor: theme.background },
  title: { fontSize: 20, color: theme.text },
});
