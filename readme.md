# Optimized Document Extraction with Form Recognizer, Customer Vision, and Logic Apps

This project demonstrates splitting a PDF file into individual pages, classification of those pages, and data extraction using the Azure Form Recognizer API. It is particularly useful for use-cases that want to extract data from one or more pages of a document, but don't want to extract data from every page. The optimizations made in this project result in significant cost savings. To deploy this project, you'll need an [Azure subscription](https://azure.microsoft.com) and API keys for Form Recognizer and Custom Vision.

## Optimizations

Form Recognizer pricing is based on the number of pages in the document, *not* the number pages processed or amount of data extracted. The original use cases that spawned this project contained two different document types:

1. Packet #1
	1. Between 3 and 12 pages in size.
	2. Contained 1 to 4 pages of interest, which were rarely beyond page 6.
2. Packet #2
	1. Between 5 and 40 pages in size.
	2. Only 1 page of interest, usually in the first 10 pages.

### Initial Implementation

The initial project used the following services:

1. Storage Account (Blob Storage)
	1. Packets are scanned and uploaded into different containers respective of their document type.
2. Logic App: Packet Processing
	1. Picks up new blobs in the packet container and submits them to the Form Recognizer API.
	2. Results are stored in Cosmos DB in the packet collection along with the original blob URL.
3. Logic App: Document Search
	1. Accepts an HTTP POST request with search criteria.
	2. Queries the packet collection in Cosmos DB for a matching blob.
	3. If a matching document is found, it returns the PDF blob (file) contents.

Implemented this way was estimated to cost around [$100,000/month](https://azure.com/e/e8d0abe220bf45be9ebd8434eb0bb020). It is worth noting that this is the most common customer implementation.

### Optimization #1

The first optimization breaks the packets into their individual pages and submits each page to Custom Vision for classification; only pages classified as being of interest are forwarded to Form Recognizer. It contained the following services:

1. Storage Account (Blob Storage)
	1. Packets are scanned and uploaded into different containers respective of their document type.
2. Function App (Node JS)
	1. Picks up new blobs in the packet container and reads each individual page, converting it to a PNG file and writing it out as a new blob (PNG file) to the packet-pages container.
3. Custom Vision
	1. Trained on each of the pages of interest and tagged as that specific page of interest.
	2. Trained on the other pages not of interest and tagged as Negative.
3. Logic App: Packet Processing
	1. Picks up new blobs in the packet-pages container and submits them to the Custom Vision.
	2. If the page is of interest, it is sent to Form Recognizer, otherwise it's deleted.
	3. Results are stored in Cosmos DB in the packet collection along with the original blob URL, then the blob for the page is deleted.
4. Logic App: Document Search
	1. Accepts an HTTP POST request with search criteria.
	2. Queries the appropriate Cosmos DB collection for a matching blob.
	3. If a matching document is found, it returns the blob (file) contents.

This implementation was estimated to cost around [$20,000/month](https://azure.com/e/70d041237c9b4aac975d83dc6e27c075), a substantial savings. This was within an acceptable range, but there were additional optimizations to be had.

### Optimization #2

Since most of the time the pages of interest are in the first half of bothp packets, additional cost savings can be had by reducing the number of transactions going to Custom Vision, as well as the time/executions of the Logic App. The Logic App was modified to check if document metadata was fully populated, and if so, terminate. This reduced the monthly cost to just over [$14,000/month](https://azure.com/e/58587aaae36143d786131a1cc603942b).

### Multiple Document Types

When handling multiple document types, there are two options, which to choose depends on the scale of each document type:

1. Separate containers and apps. This option makes the most sense when there are many of a specific document type being processed in a month. This allows scaling to be independent for those document types.
	1. Create a container for each document type.
	2. Function Apps and Logic Apps can only trigger on one container, so create a copy of the Function App and processing Logic App for each container.
2. Separate containers and Service Bus. This option makes the most sense when the number of documents for a document type is small to moderate.
	1. Create a container for each document type.
	2. Copy the Split-PDF *folder* and rename each folder (e.g. Split-Invoice, Split-Shipping, Split-Customer). This is done for each container, since Function Apps can only trigger on one container at a time. This means that each document type is handled inside the same Function App and they do **not** scale independently, but it's easier to organize and maintain.
	3. Modify the Function App so that as each page blob is written, it sends a message to Service Bus containing the relevant data about the new blob.
	4. Modify the processing Logic App to trigger on Service Bus messages. This reduces deployment maintenance and a single Logic App can handle many document types that produce small to moderate numbers.

#### Service Bus

Each page split from the PDF results in a message sent to Service Bus. The message sent to service bus contains two properties:

+ Blob - the full path to a page.
+ DocumentType - the document type, which is derived from the container name (replacing hyphens with spaces).

In a production workload, if possible, it would be recommended to add metadata to each blob, and then to grab this metadata and include desired metadata properties in the service bus message. This could include original file name, customer name, customer ID, document type, etc.

## Setup

All configuration is handled through environment variables or function bindings (while working locally, this is done using the *local.settings.json* file.)

### Deploying Function App

After cloning the repository, update the configuration settings (see below), and deploy using your preferred method. See [this document](https://docs.microsoft.com/en-us/azure/azure-functions/functions-reference-node) for deploying Function Apps using Visual Studio Code.

### Function Bindings

Edit the *function.json* file and update the following:

+ Storage Account Binding
++ *path* - replace {container-name} with the name of the container in your Storage Account. If your path is more complex, you'll need to update it with your full path. Don't touch "{name}.pdf".
++ *connection* - if you're just using the Function App default storage, you can to "AzureWebJobsStorage".
+ Service Bus Binding
++ *accessRights* - in sticking with the principles of least privilege, this is set to "listen". If using a connection string to Service Bus that has manage permissions, change to "manage".
++ *queueName* - if you're using a Service Bus queue, set this to the name of the queue, otherwise leave it blank.
++ *topicName* - if you're using a Service Bus topic, set this to the name of the topic, otherwise leave it blank.

### Environment Variables

The following environment variables are used:

+ *PagesContainer* - the name of the container that's the destination for individual PDF pages (or PNG images of pages). This should **not** be the same as the container that triggers the function.
+ *RequiresClassification* - set this to *true* if pages require classification. Pages require classification if you have a document containing multiple pages, and you don't need to extract data from every page. If you need to extra data from every page, set it to *false*.
+ *ServiceBus* - copy/paste the Service Bus connection string if you plan to use Service Bus. You should only use Service Bus if you plan to have a single Logic App process multiple document types.
+ *StorageAccount* - copy/paste the connection string of the Storage Account that contains the pages container.

## Storage Account

Now create the containers you specified above in the settings: the document container (where documents get uploaded); and the pages container (where the Function App breaks the PDF into individual pages).

## Cosmos DB

The throughput on the Cosmos DB database defaults to 400 RU/second and the partition key is set to "/customerName" that is defaulted to "Unknown" in the Logic Apps and Function App. You'll want to change these values based on your use case.

## Training

Next you'll need to train Custom Vision and Form Recognizer.

### Training Custom Vision

The easiest way to train Custom Vision is by going to the Azure Portal.

1. Select the resource group you deployed to.
2. Click the Custom Vision service (not prediction).
3. Go to the *Quick start* on the left navigation menu if it doesn't take you there.
4. Under section 2, click the *Custom Vision portal*.
5. Create a project for the document type.
6. Upload at least 5, preferrably 10 pages for each page of interest; tag those pages appropriately.
7. Upload at least 3, up to 5 samples of all the pages *you don't care about* and tag them *Negative*.
8. Train the model. If pages are structurally different, Simple Training may work, otherwise Advanced Training is recommended.
9. When training completes, review the performance. If performance is acceptable, publish the model. Pay attention to the name you give it.

### Training Form Recognizer

Follow the [documentation](https://docs.microsoft.com/en-us/azure/cognitive-services/form-recognizer/). If you're extracting pieces from one or more pages, you should check out the [labeling tool](https://docs.microsoft.com/en-us/azure/cognitive-services/form-recognizer/quickstarts/label-tool) first. Otherwise, if you're extracting a whole page or from tables, you should check out the [Python documentation](https://docs.microsoft.com/en-us/azure/cognitive-services/form-recognizer/quickstarts/python-train-extract).

If you use the labeling tool, note that you'll need to turn on CORS (per the documentation) for the Storage Account. After you've done the training, you'll want to turn CORS off, or the Logic Apps won't work.

### Logic Apps

The logic apps will need their API connectors updated with your service keys. You'll need to get the API keys for the Cognitive Services (Custom Vision and Form Recognizer), Storage Account, and Cosmos DB. It's easiest to open Logic Apps in your primary browser tab, and open each service in another tab to copy/paste their API keys. Once you've got the tabs open, in your primary tab with the Logic Apps:

1. On the left navigation, click *API connections*.
2. For each connection, and on the left navigation, select *Edit API connection*.
3. Copy/paste the account key, and update with any other information you wish to enter, then save it.

Next you'll need to update the configuration for Custom Vision.

1. Find and click the *Classify page* action.
2. Change the *Project ID* to the published Project ID of your Custom Vision model.
3. Change the *Published Name* to the name you gave the Custom Vision model when you published.

Because Form Recognizer is in preview, the Logic App connectors aren't always up-to-date, so you'll need to update the HTTP request made in the document extraction Logic App.

1. In the document processing Logic App, click *Logic app designer*.
2. Find and click the *Form Recognizer: Analyze Form* action.
3. Find the *Ocp-Apim-Subscription-Key* header and copy/paste your Form Recognizer API key.
4. Find and click the *Until analysis completes* action.
5. Find and click the *Form Recognizer: Get Analysis Result* action and copy/paste your Form Recognizer API key.

Profit!