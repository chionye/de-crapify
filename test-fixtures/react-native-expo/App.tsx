import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Header from '@/components/Header';
import { PrimaryButton } from './components/Button';
import { formatPrice } from '@/lib/price';

const logo = require('./assets/logo.png');

// Main App component
export default function App() {
  // State for the cart count
  const [count, setCount] = useState(0);

  if (__DEV__) {
    console.log('App rendered in dev mode');
  }

  return (
    <View style={styles.container}>
      <Header title="Shop" />
      <Image source={logo} style={styles.logo} />
      <Text>{formatPrice(count * 999)}</Text>
      <PrimaryButton label="Add to cart" onPress={() => setCount(count + 1)} />
      <PrimaryButton label="Debug" onPress={() => console.log('pressed')} />
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 64, height: 64 },
});
