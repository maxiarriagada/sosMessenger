import 'package:material_ui/material_ui.dart';

import 'home_page.dart';

void main() {
  runApp(const LmApp());
}

class LmApp extends StatelessWidget {
  const LmApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'LoRa Messenger',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF2DD4BF),
          brightness: Brightness.dark,
        ),
      ),
      home: const LmHomePage(),
    );
  }
}
