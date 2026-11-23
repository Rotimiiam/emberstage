#!/usr/bin/env python3
"""Public GET-only readiness, TLS and denied-port checks; never print bodies."""
import http.client
import json
import socket
import ssl

HOST = 'account.emberstage.live'
IP = '54.166.237.147'
try:
    assert {x[4][0] for x in socket.getaddrinfo(HOST, 443, family=socket.AF_INET)} == {IP}
    context = ssl.create_default_context()
    with socket.create_connection((IP, 443), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname=HOST) as tls:
            cert = tls.getpeercert()
            assert cert['subjectAltName'] == (('DNS', HOST),)
            expires = cert['notAfter']
    results = {}
    paths = {
        '/app': 200, '/app/app.js': 200, '/app/app.css': 200,
        '/assets/brand/favicon.svg': 200, '/assets/brand/emberstage-logo.svg': 200,
        '/assets/brand/emberstage-wordmark.svg': 200, '/assets/css/emberstage_brand.css': 200,
        '/api/auth/config': 200, '/api/billing/plan': 200,
        '/api/auth/me': 401, '/api/workspaces': 401,
        '/api/streams/publish': 403, '/api/streams/publish_done': 403,
        '/camera': 503,
    }
    for path, expected in paths.items():
        connection = http.client.HTTPSConnection(HOST, timeout=10, context=context)
        connection.request('GET', path)
        response = connection.getresponse()
        data = response.read(1024 * 1024)
        assert response.status == expected
        results[path] = response.status
        if path == '/api/auth/config':
            auth = json.loads(data)
            assert auth['google']['enabled'] is False and auth['auth0']['enabled'] is False
        if path == '/api/billing/plan':
            billing = json.loads(data)
            assert billing['checkoutAvailable'] is False and billing['mode'] == 'unconfigured'
        connection.close()
    connection = http.client.HTTPSConnection(HOST, timeout=10, context=context)
    connection.request('GET', '/api/auth/config', headers={'Origin': 'https://untrusted.invalid'})
    response = connection.getresponse(); response.read()
    assert response.status == 403
    connection.close()
    connection = http.client.HTTPConnection(HOST, timeout=10)
    connection.request('GET', '/app')
    response = connection.getresponse(); response.read()
    assert response.status == 308 and response.getheader('Location') == 'https://' + HOST + '/app'
    connection.close()
    for port in (3000, 1935):
        try:
            with socket.create_connection((IP, port), timeout=5):
                raise AssertionError('PUBLIC_PORT_OPEN')
        except (TimeoutError, ConnectionRefusedError, OSError) as exc:
            if isinstance(exc, AssertionError):
                raise
    print('EMBERSTAGE_PUBLIC_READINESS_VERIFIED')
    print(json.dumps({'routes': results, 'cross_origin': 403, 'http_redirect': 308,
                      'certificate_san': HOST, 'certificate_expires': expires,
                      'node_rtmp_public_ports_closed': True, 'payment_unconfigured': True}, sort_keys=True))
except Exception:
    print('EMBERSTAGE_PUBLIC_READINESS_FAILED')
    raise SystemExit(1)
