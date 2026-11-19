import 'dart:convert';

import 'package:material_ui/material_ui.dart';

import '../ble/lm_ble_service.dart';
import '../ble/lm_packets.dart';
import 'lm_chat_store.dart';

class LmChatPage extends StatefulWidget {
  const LmChatPage({
    super.key,
    required this.ble,
    required this.store,
    required this.showMessage,
  });

  final LmBleService ble;
  final LmChatStore store;
  final void Function(String message) showMessage;

  @override
  State<LmChatPage> createState() => _LmChatPageState();
}

class _LmChatPageState extends State<LmChatPage> {
  final _textController = TextEditingController();
  final _scrollController = ScrollController();
  bool _broadcast = true;
  String? _target;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    widget.store.addListener(_scrollToBottom);
  }

  @override
  void dispose() {
    widget.store.removeListener(_scrollToBottom);
    _textController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) {
        return;
      }
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  String? _effectiveTarget(List<String> peers) {
    if (_broadcast) {
      return null;
    }
    if (_target != null && peers.contains(_target)) {
      return _target;
    }
    return peers.isEmpty ? null : peers.first;
  }

  Future<void> _send() async {
    final text = _textController.text.trim();
    if (text.isEmpty || _sending) {
      return;
    }
    final peers = widget.ble.peers.map((peer) => peer.id).toList();
    final target = _effectiveTarget(peers);
    if (!_broadcast && target == null) {
      widget.showMessage('No hay peers para enviar un mensaje 1:1');
      return;
    }
    setState(() => _sending = true);
    final packet = await widget.ble.sendText(
      to: target ?? '*',
      text: text,
      broadcast: _broadcast,
    );
    if (!mounted) {
      return;
    }
    setState(() => _sending = false);
    if (packet == null) {
      widget.showMessage(widget.ble.error ?? 'No se pudo enviar el mensaje');
      return;
    }
    await widget.store.addOutgoing(packet);
    if (!mounted) {
      return;
    }
    _textController.clear();
    _scrollToBottom();
  }

  Future<void> _confirmClear() async {
    final clear = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Borrar historial'),
        content: const Text(
          'Se eliminarán los mensajes guardados en este teléfono.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Borrar'),
          ),
        ],
      ),
    );
    if (clear == true) {
      await widget.store.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([widget.ble, widget.store]),
      builder: (context, _) {
        final peers = widget.ble.peers.map((peer) => peer.id).toList();
        final target = _effectiveTarget(peers);
        final messages = widget.store.messages;
        final scheme = Theme.of(context).colorScheme;
        final textBytes = utf8.encode(_textController.text).length;
        return Column(
          children: [
            _composerCard(peers, target, textBytes, scheme),
            Expanded(
              child: messages.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(32),
                        child: Text(
                          widget.ble.connected
                              ? 'Todavía no hay mensajes.\nEscribe el primero abajo.'
                              : 'Conecta el nodo LM para enviar mensajes.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: scheme.outline),
                        ),
                      ),
                    )
                  : ListView.builder(
                      controller: _scrollController,
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                      itemCount: messages.length,
                      itemBuilder: (context, index) =>
                          _messageBubble(messages[index], scheme),
                    ),
            ),
          ],
        );
      },
    );
  }

  Widget _composerCard(
    List<String> peers,
    String? target,
    int textBytes,
    ColorScheme scheme,
  ) {
    final canSend =
        widget.ble.connected &&
        !_sending &&
        (_broadcast || target != null) &&
        _textController.text.trim().isNotEmpty;
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Mensajes',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                Text(
                  '${widget.store.messages.length}',
                  style: TextStyle(color: scheme.outline),
                ),
                IconButton(
                  tooltip: 'Borrar historial',
                  onPressed: widget.store.messages.isEmpty
                      ? null
                      : _confirmClear,
                  icon: const Icon(Icons.delete_outline),
                ),
              ],
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: const Text('Broadcast a todos'),
              subtitle: const Text('El mensaje se retransmite por el hub'),
              value: _broadcast,
              onChanged: (value) => setState(() => _broadcast = value),
            ),
            if (!_broadcast)
              InputDecorator(
                decoration: const InputDecoration(
                  labelText: 'Destino',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<String>(
                    value: target,
                    isExpanded: true,
                    hint: const Text('Selecciona un peer'),
                    items: peers
                        .map(
                          (id) => DropdownMenuItem<String>(
                            value: id,
                            child: Text(id),
                          ),
                        )
                        .toList(),
                    onChanged: peers.isEmpty
                        ? null
                        : (value) => setState(() => _target = value),
                  ),
                ),
              ),
            if (!_broadcast && peers.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'Sin peers en el snapshot del hub.',
                  style: TextStyle(color: scheme.error),
                ),
              ),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: _textController,
                    minLines: 1,
                    maxLines: 3,
                    textInputAction: TextInputAction.send,
                    onChanged: (_) => setState(() {}),
                    onSubmitted: (_) => _send(),
                    decoration: InputDecoration(
                      hintText: _broadcast
                          ? 'Mensaje para todos'
                          : 'Mensaje 1:1',
                      border: const OutlineInputBorder(),
                      isDense: true,
                      helperText: '$textBytes/$lmTextMaxBytes bytes UTF-8',
                      helperStyle: TextStyle(
                        color: textBytes > lmTextMaxBytes
                            ? scheme.error
                            : scheme.outline,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  tooltip: 'Enviar',
                  onPressed: canSend ? _send : null,
                  icon: _sending
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.send),
                ),
              ],
            ),
            if (!widget.ble.connected)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'Sin nodo BLE conectado.',
                  style: TextStyle(color: scheme.tertiary),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _messageBubble(LmChatMessage message, ColorScheme scheme) {
    final outgoing = message.outgoing;
    final background = outgoing
        ? scheme.primaryContainer
        : scheme.surfaceContainerHighest;
    final foreground = outgoing
        ? scheme.onPrimaryContainer
        : scheme.onSurfaceVariant;
    final destination = message.broadcast ? 'Todos' : message.to;
    final title = outgoing ? 'Tú → $destination' : message.from;
    return Align(
      alignment: outgoing ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 360),
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Text(
                    title,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: foreground,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  _time(message.sentAt),
                  style: TextStyle(color: foreground, fontSize: 11),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              message.text,
              style: TextStyle(color: foreground, fontSize: 15),
            ),
            if (outgoing) ...[
              const SizedBox(height: 4),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    _statusIcon(message),
                    size: 14,
                    color: message.status == LmChatStatus.failed
                        ? scheme.error
                        : foreground,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    _statusLabel(message),
                    style: TextStyle(
                      color: message.status == LmChatStatus.failed
                          ? scheme.error
                          : foreground,
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  IconData _statusIcon(LmChatMessage message) {
    if (message.broadcast) {
      return Icons.campaign_outlined;
    }
    switch (message.status) {
      case LmChatStatus.sent:
        return Icons.schedule;
      case LmChatStatus.delivered:
        return Icons.done_all;
      case LmChatStatus.failed:
        return Icons.error_outline;
    }
  }

  String _statusLabel(LmChatMessage message) {
    if (message.broadcast) {
      return 'Broadcast';
    }
    switch (message.status) {
      case LmChatStatus.sent:
        return 'Enviado';
      case LmChatStatus.delivered:
        return 'Entregado';
      case LmChatStatus.failed:
        return 'Falló';
    }
  }

  String _time(DateTime value) {
    final local = value.toLocal();
    return '${local.hour.toString().padLeft(2, '0')}:'
        '${local.minute.toString().padLeft(2, '0')}';
  }
}
