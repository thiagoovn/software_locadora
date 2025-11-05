# server.py
# atualização forçada para corrigir indentação
from flask import Flask, request, send_file, jsonify
import os
from datetime import datetime
import tempfile

from main import gerar_ficha_locacao, gerar_contrato_completo

app = Flask(__name__)

OUTPUT_FOLDER = os.path.join(os.path.dirname(__file__), "contratos_enviados")
os.makedirs(OUTPUT_FOLDER, exist_ok=True)


@app.route('/gerar_contrato', methods=['POST'])
def gerar_contrato_endpoint():
    dados = request.get_json()
    if not dados:
        return jsonify({"error": "Nenhum dado recebido"}), 400

    try:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        nome_pdf = f"contrato_{dados.get('nome', 'cliente').replace(' ', '_')}_{ts}.pdf"
        caminho_pdf = os.path.join(OUTPUT_FOLDER, nome_pdf)

        gerar_ficha_locacao(dados, caminho_pdf)
        out_path = gerar_contrato_completo(caminho_pdf)

        return send_file(out_path, as_attachment=True, download_name=os.path.basename(out_path),
                         mimetype='application/pdf')


    except Exception as e:

        import traceback

        print("❌ ERRO AO GERAR CONTRATO:")

        traceback.print_exc()

        return jsonify({

            "error": str(e),

            "trace": traceback.format_exc()

        }), 500


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000, debug=False)
