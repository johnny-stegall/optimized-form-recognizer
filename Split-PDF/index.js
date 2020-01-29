const { BlobServiceClient } = require("@azure/storage-blob");
const { PDFDocument } = require("pdf-lib");
const Canvas = require("canvas");
const PDFJS = require("pdfjs-dist");

function NodeCanvasFactory() {}
NodeCanvasFactory.prototype =
{
  /****************************************************************************
  * Creates the canvas.
  * @param {int} width The canvas width.
  * @param {int} height The canvas height.
  ****************************************************************************/
  create: function NodeCanvasFactory_create(width, height)
  {
    var canvas = Canvas.createCanvas(width, height);
    var context = canvas.getContext("2d");

    return {
      canvas: canvas,
      context: context
    };
  },

  /****************************************************************************
  * Resets the canvas.
  * @param {object} canvasAndContext The canvas and its context.
  * @param {int} width The canvas width.
  * @param {int} height The canvas height.
  ****************************************************************************/
  reset: function NodeCanvasFactory_reset(canvasAndContext, width, height)
  {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  },

  /****************************************************************************
  * Destroys the canvas.
  * @param {object} canvasAndContext The canvas and its context.
  ****************************************************************************/
  destroy: function NodeCanvasFactory_destroy(canvasAndContext)
  {
    // Zeroing the width and height cause Firefox to release graphics
    // resources immediately, which can greatly reduce memory consumption.
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
};

/******************************************************************************
* Function entry point.
******************************************************************************/
module.exports = async function(context, pdfBlob)
{
  context.log(`Triggered by: ${context.bindingData.blobTrigger} (${pdfBlob.length} bytes).`);

  try
  {
    const fileName = context.bindingData.name;
    const storageClient = await BlobServiceClient.fromConnectionString(process.env.StorageAccount);
    const pagesContainer = await storageClient.getContainerClient(process.env.PagesContainer);
    const pdfDocument = await PDFDocument.load(pdfBlob);
    const pdfPages = pdfDocument.getPages();
    const requiresClassification = (process.env.RequiresClassification);
    let imageBlob = null;
    let pageBlob = null;

    for (var pageIndex = 0; pageIndex < pdfPages.length; pageIndex++)
    {
      
      const pdfData = await extractPage(pdfDocument, pageIndex);

      if (requiresClassification)
      {
        const imageData = await convertPdfToImage(pdfData);

        if (imageData)
        {
          imageBlob = pagesContainer.getBlockBlobClient(`${fileName.substr(0, fileName.lastIndexOf("."))}-${pageIndex}.png`);
          await imageBlob.upload(imageData[0], imageData[0].length);
        }
      }
      else
      {
        pageBlob = pagesContainer.getBlockBlobClient(`${fileName.substr(0, fileName.lastIndexOf("."))}-${pageIndex}.pdf`);
        await pageBlob.upload(pdfData, pdfData.length);
      }
    }

    context.log(`Finished splitting ${context.bindingData.blobTrigger} into ${pdfPages.length} pages.`);

    if (process.env.ServiceBus != "")
    {
      return {
        "Blob": imageBlob || pageBlob,
        "Document Type": context.bindingData.blobTrigger.substr(context.bindingData.blobTrigger.indexOf("/")).replace("-", " ")
      };
    }
  }
  catch (e)
  {
    context.log(`Exception occurred splitting pages from ${context.bindingData.blobTrigger}: ${e}.`);
  }
};

/******************************************************************************
* Copies a page from an existing PDF and saves it into a new PDF.
*
* @param {object} pdfDocument The PDF document.
* @param {int} pageIndex The index of the page to copy.
* @returns {array} The PDF data as a byte array or null if there's an error.
******************************************************************************/
async function extractPage(pdfDocument, pageIndex)
{
  try
  {
    const newPdf = await PDFDocument.create();
    const [copiedPage] = await newPdf.copyPages(pdfDocument, [pageIndex]);
    await newPdf.addPage(copiedPage);
    return await newPdf.save();
  }
  catch (e)
  {
    console.log(`Failed to convert PDF to an image.`);
    return null;
  }
}

/******************************************************************************
* Converts a PDF into an image array.
*
* @param {array} pdfData The PDF data as a byte array.
* @returns {array} An array with the byte array for each page as an image or
* null if there's an error.
******************************************************************************/
async function convertPdfToImage(pdfData)
{
  const pdfDocument = await PDFJS.getDocument(pdfData);
  let imagePages = [];

  try
  {
    for (let pageIndex = 0; pageIndex < pdfDocument.numPages; pageIndex++)
    {
      const pdfPage = await pdfDocument.getPage(pageIndex + 1);

      // Configure a Node canvas with 100% scale
      const viewport = pdfPage.getViewport({ scale: 1.0 });
      const canvasFactory = new NodeCanvasFactory();
      const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
      const renderContext = {
        canvasContext: canvasAndContext.context,
        viewport: viewport,
        canvasFactory: canvasFactory,
      };
      
      // Render the page the Node canvas and then an image buffer
      await pdfPage.render(renderContext);
      imagePages.push(canvasAndContext.canvas.toBuffer());
    }

    return imagePages.length > 0 ? imagePages : null;
  }
  catch (e)
  {
    console.log(`Failed to convert PDF to an image.`);
    return null;
  }
}