import os, tempfile
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.lib.units import mm
from textwrap import wrap
from PyPDF2 import PdfReader, PdfWriter
from PIL import Image, ImageChops

from datetime import datetime, timedelta

def calcular_dias(data_inicio_str, data_fim_str):
    """Calcula a diferença em dias (aceita formato com ou sem hora)."""
    formatos = ["%d/%m/%Y %H:%M", "%d/%m/%Y"]
    inicio, fim = None, None

    for fmt in formatos:
        try:
            inicio = datetime.strptime(data_inicio_str, fmt)
            break
        except:
            continue

    for fmt in formatos:
        try:
            fim = datetime.strptime(data_fim_str, fmt)
            break
        except:
            continue

    if not inicio or not fim:
        return 1

    diferenca = fim - inicio
    dias = diferenca.total_seconds() / (24 * 3600)
    dias = int(dias) if dias.is_integer() else int(dias) + 1
    return max(dias, 1)

# ======= CONFIGURAÇÕES =======
BASE_DIR = r"C:\Users\thiag\PycharmProjects\Cursoemvideo\Thiagoo\locadora"
BASE_MODELOS = os.path.join(BASE_DIR, "contratos_modelo")
OUTPUT_FOLDER = os.path.join(BASE_DIR, "contratos_enviados")
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

LOGO_FILE = os.path.join(BASE_MODELOS, "logomarca.jpg")
SIGNATURE_JPG = os.path.join(BASE_MODELOS, "assinatura.jpg")
CHECKLIST_IMG = os.path.join(BASE_MODELOS, "Checklistt.jpg")
CLAUSULA_PDF = os.path.join(BASE_MODELOS, "clausula.pdf")

A4_W, A4_H = A4

# ======= UTILITÁRIOS =======
def crop_whitespace(pil_img, pad=3):
    if pil_img.mode != "RGB":
        img = pil_img.convert("RGB")
    else:
        img = pil_img
    bg = Image.new("RGB", img.size, img.getpixel((0, 0)))
    diff = ImageChops.difference(img, bg)
    bbox = diff.getbbox()
    if bbox:
        left = max(0, bbox[0] - pad)
        upper = max(0, bbox[1] - pad)
        right = min(img.width, bbox[2] + pad)
        lower = min(img.height, bbox[3] + pad)
        return img.crop((left, upper, right, lower))
    return img

def get_checklist_image_tmp():
    if os.path.exists(CHECKLIST_IMG):
        with Image.open(CHECKLIST_IMG) as im:
            cropped = crop_whitespace(im)
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
            cropped.save(tmp.name, "PNG")
            return tmp.name
    return None

def quebra_texto(c, texto, x, y, largura, tamanho_fonte=9, espaco_linha=4):
    c.setFont("Helvetica", tamanho_fonte)
    for linha in wrap(texto, width=int(largura / (tamanho_fonte * 0.55))):
        c.drawString(x, y, linha)
        y -= (tamanho_fonte + espaco_linha)
    return y

# ======= GERA PÁGINA 1 =======
def gerar_ficha_locacao(dados, caminho_pdf):
    c = canvas.Canvas(caminho_pdf, pagesize=A4)
    largura, altura = A4
    margem = 15 * mm

    if os.path.exists(LOGO_FILE):
        logo = ImageReader(LOGO_FILE)
        iw, ih = logo.getSize()
        logo_w = 170 * mm
        logo_h = logo_w * (ih / iw)
        c.drawImage(LOGO_FILE, (largura - logo_w) / 2, altura - margem - logo_h, width=logo_w, height=logo_h)

    c.setFont("Helvetica-Bold", 13)
    c.drawCentredString(largura / 2, altura - 130, "CONTRATO DE LOCAÇÃO DE VEÍCULO")

    loc = dados
    y = altura - 150
    box_altura = 65
    box_largura = 120 * mm

    c.setFont("Helvetica-Bold", 10)
    c.drawString(margem, y + 5, "LOCATÁRIO")
    c.rect(margem, y - box_altura, box_largura, box_altura)
    c.setFont("Helvetica", 9)
    linha_y = y - 12
    c.drawString(margem + 7, linha_y, f"Nome: {loc['nome']}")
    linha_y -= 12
    c.drawString(margem + 7, linha_y, f"CPF/CNPJ: {loc['cpf']}")
    c.drawString(margem + 65 * mm, linha_y, f"Telefone: {loc['telefone']}")
    linha_y -= 12
    c.drawString(margem + 7, linha_y, f"E-mail: {loc.get('email', '-')}")
    linha_y -= 12
    linha_y = quebra_texto(c, f"Endereço: {loc['endereco']}", margem + 7, linha_y, 110 * mm)

    box2_x = 430
    dias = calcular_dias(loc["data_inicio"], loc["data_devolucao"])


    c.setFont("Helvetica-Bold", 10)
    c.drawString(box2_x, y + 5, "PERÍODO DE LOCAÇÃO")
    c.rect(box2_x, y - box_altura, 145, box_altura)
    c.setFont("Helvetica", 9)
    linha_y = y - 12
    c.drawString(box2_x + 7, linha_y, f"Início: {loc['data_inicio']}")
    linha_y -= 12
    c.drawString(box2_x + 7, linha_y, f"Previsão: {loc['data_devolucao']}")
    linha_y -= 12
    c.drawString(box2_x + 7, linha_y, f"Dia(s): {dias}")

    y -= 105
    c.setFont("Helvetica-Bold", 10)
    c.drawString(margem, y + 15, "LOCAÇÃO")
    c.rect(margem, y - 25, largura - 2 * margem, 28)
    c.setFont("Helvetica", 9)
    linha_y = y - 12
    c.drawString(margem + 7, linha_y, f"Plano: KM LIVRE")
    c.drawString(margem + 65 * mm, linha_y, f"Veículo: {loc['carro']}")
    c.drawString(margem + 140 * mm, linha_y, f"Placa: {loc['placa']}")
    linha_y -= 12
    c.drawString(margem + 7, linha_y, f"Renavam: {loc.get('renavam', '-')}")

    y -= 70
    resumo_altura = 72 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(margem, y + 5, "RESUMO")
    c.rect(margem, y - resumo_altura, 125 * mm, resumo_altura)

    c.setFont("Helvetica-Bold", 9)
    c.drawString(margem + 7, y - 12, "Descrição")
    c.drawString(margem + 68 * mm, y - 12, "Dia/Km")
    c.drawString(margem + 88 * mm, y - 12, "Valor")
    c.drawString(margem + 108 * mm, y - 12, "Total")

    valor_diaria = float(str(loc.get("valor_diaria", "0")).replace(",", "."))
    desconto = float(str(loc.get("desconto", "0")).replace(",", "."))
    total_locacao = valor_diaria * dias
    total_pagar = total_locacao - desconto

    resumo = [
        ("PLANO KM LIVRE", str(dias), f"{valor_diaria:,.2f}".replace(".", ","), f"{total_locacao:,.2f}".replace(".", ",")),
        ("SEGURO DO VEÍCULO", str(dias), "0,00", "0,00"),
        ("SEGURO TERCEIROS NÃO CONTRATADO", "0", "0,00", "0,00"),
    ]

    totais = [
        ("TOTAL DA LOCAÇÃO", f"R$ {total_locacao:,.2f}".replace(".", ",")),
        ("DESCONTO (-)", f"R$ {desconto:,.2f}".replace(".", ",")),
        ("TOTAL A PAGAR", f"R$ {total_pagar:,.2f}".replace(".", ",")),
    ]

    c.setFont("Helvetica", 9)
    pos_y = y - 25
    for desc, dia, val, tot in resumo:
        # Descrição
        c.drawString(margem + 7, pos_y, desc)
        # Dia/Km (coluna central)
        c.drawCentredString(margem + 78 * mm, pos_y, str(dia))
        # Valor (coluna ao lado direito)
        c.drawRightString(margem + 98 * mm, pos_y, f"R$ {val}")
        # Total (última coluna à direita)
        c.drawRightString(margem + 118 * mm - 7, pos_y, f"R$ {tot}")
        pos_y -= 20

    c.setFont("Helvetica-Bold", 9)
    pos_y -= 8
    for t, v in totais:
        c.drawString(margem + 7, pos_y, t)
        c.drawRightString(margem + 118 * mm - 7, pos_y, v)
        pos_y -= 13

    c.setFont("Helvetica-Bold", 10)
    c.drawString(margem + 7, pos_y - 5, f"FORMA DE PAGAMENTO: {loc.get('forma_pag','-')}")

    obs_y = y - resumo_altura - 50
    obs_altura = 60
    c.setFont("Helvetica-Bold", 10)
    c.drawString(margem, obs_y + 5, "OBSERVAÇÕES")
    c.rect(margem, obs_y - obs_altura, largura - 2 * margem, obs_altura)
    quebra_texto(c, loc.get("observacoes", "-"), margem + 7, obs_y - 10, largura - 2 * margem - 15)

    if os.path.exists(SIGNATURE_JPG):
        sig = ImageReader(SIGNATURE_JPG)
        iw, ih = sig.getSize()
        sig_w = 170 * mm
        sig_h = sig_w * (ih / iw)
        c.drawImage(SIGNATURE_JPG, (largura - sig_w) / 2, 25 * mm, width=sig_w, height=sig_h)

    c.save()
    print("✅ Página 1 gerada com sucesso.")

# ======= PÁGINA 2 =======
def create_page2(out_path, checklist_img, signature_img):
    c = canvas.Canvas(out_path, pagesize=A4)
    margem = 20 * mm

    if os.path.exists(LOGO_FILE):
        logo = ImageReader(LOGO_FILE)
        iw, ih = logo.getSize()
        logo_w = 170 * mm
        logo_h = logo_w * (ih / iw)
        c.drawImage(LOGO_FILE, (A4_W - logo_w) / 2, A4_H - margem - logo_h, width=logo_w, height=logo_h)

    if checklist_img and os.path.exists(checklist_img):
        with Image.open(checklist_img) as im:
            iw, ih = im.size
            aspect = ih / iw
        target_w, target_h = 180 * mm, 250 * mm
        final_w, final_h = target_w, target_w * aspect
        if final_h > target_h:
            final_h, final_w = target_h, target_h / aspect
        c.drawImage(checklist_img, (A4_W - final_w) / 2, (A4_H - final_h) / 2, width=final_w, height=final_h)

    if signature_img and os.path.exists(signature_img):
        with Image.open(signature_img) as img:
            iw, ih = img.size
            aspect = ih / iw
        sig_w = 170 * mm
        sig_h = sig_w * aspect
        c.drawImage(signature_img, (A4_W - sig_w) / 2, 20 * mm, width=sig_w, height=sig_h)

    c.showPage()
    c.save()

# ======= CONTRATO COMPLETO =======
def gerar_contrato_completo(caminho_pdf_existente):
    print("➡️ Gerando páginas 2 e 3...")
    tmp_files = []
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    signature_tmp = None
    if os.path.exists(SIGNATURE_JPG):
        with Image.open(SIGNATURE_JPG) as im:
            cropped = crop_whitespace(im)
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
            cropped.save(tmp.name, "PNG")
            signature_tmp = tmp.name
            tmp_files.append(signature_tmp)

    checklist_tmp = get_checklist_image_tmp()
    if checklist_tmp:
        tmp_files.append(checklist_tmp)

    p2 = os.path.join(OUTPUT_FOLDER, f"tmp_page2_{ts}.pdf")
    create_page2(p2, checklist_tmp, signature_tmp)

    clausula_tmp = None
    if os.path.exists(CLAUSULA_PDF):
        clausula_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
        reader = PdfReader(CLAUSULA_PDF)
        writer = PdfWriter()
        for page in reader.pages:
            page.scale_to(A4_W, A4_H)
            writer.add_page(page)
        with open(clausula_tmp.name, "wb") as f:
            writer.write(f)
        tmp_files.append(clausula_tmp.name)

    writer = PdfWriter()
    for pg in PdfReader(caminho_pdf_existente).pages:
        writer.add_page(pg)
    for pg in PdfReader(p2).pages:
        writer.add_page(pg)
    if clausula_tmp:
        for pg in PdfReader(clausula_tmp.name).pages:
            writer.add_page(pg)

    out_path = os.path.join(OUTPUT_FOLDER, os.path.basename(caminho_pdf_existente))
    with open(out_path, "wb") as f:
        writer.write(f)

    for fp in tmp_files + [p2, clausula_tmp.name if clausula_tmp else None]:
        if fp and os.path.exists(fp):
            try: os.remove(fp)
            except: pass

    print(f"✅ Contrato completo gerado: {out_path}")
    return out_path

# ======= MOCKUP DE DADOS E FUNÇÃO PRINCIPAL =======
def gerar_contrato():

    dados_mock = {
        "nome": "José Neto",
        "cpf": "123.456.789-00",
        "telefone": "(81) 99999-9999",
        "email": "thiago@email.com",
        "endereco": "Rua Teste de Layout, 123 - Boa Viagem, Recife - PE",
        "carro": "Fiat Argo 1.3",
        "placa": "ABC-1A23",
        "renavam": "98765432100",
        "data_inicio": "30/10/2025 10:00",
        "data_devolucao": "02/11/2025 10:00",
        "valor_diaria": "150,00",
        "desconto": "50,00",
        "forma_pag": "PIX",
        "observacoes": "Cliente retornará o veículo no mesmo local de retirada. Verificar nível de combustível e quilometragem ao devolver.",
    }

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    nome_pdf = f"contrato_{dados_mock['nome'].replace(' ', '_')}_{ts}.pdf"
    caminho_pdf = os.path.join(OUTPUT_FOLDER, nome_pdf)

    print("➡️ Gerando página 1 (dados do contrato)...")
    gerar_ficha_locacao(dados_mock, caminho_pdf)
    gerar_contrato_completo(caminho_pdf)

    print("\n✅ Processo concluído com sucesso!")
    print(f"📁 Arquivo final: {caminho_pdf}")
    return caminho_pdf

if __name__ == "__main__":
    gerar_contrato()
