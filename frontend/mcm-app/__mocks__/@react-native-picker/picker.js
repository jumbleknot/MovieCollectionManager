/**
 * Mock for @react-native-picker/picker (not installed; used in tests only).
 * Provides a minimal Picker component that Jest can resolve.
 */

const React = require('react');
const { View, Text, TouchableOpacity } = require('react-native');

function Picker({ selectedValue, onValueChange, children, testID, accessibilityLabel }) {
  return React.createElement(
    View,
    { testID, accessibilityLabel, onValueChange },
    children,
  );
}

Picker.Item = function PickerItem({ label, value }) {
  return React.createElement(Text, null, label);
};

module.exports = { Picker };
