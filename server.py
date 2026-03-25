"""GCG META - Local development server with .webp support"""
import http.server
import mimetypes

# Add .webp MIME type (Python doesn't include it by default)
mimetypes.add_type('image/webp', '.webp')

if __name__ == '__main__':
    server = http.server.HTTPServer(('', 8080), http.server.SimpleHTTPRequestHandler)
    print('GCG META server running at http://localhost:8080')
    print('Press Ctrl+C to stop')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
