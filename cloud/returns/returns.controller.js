const shippo = require('shippo')(process.env.SHIPPO_API_TOKEN);
var moment = require('moment');
const Mailgun = require('mailgun-js');
const mailgun = new Mailgun({ apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN });
const request = require('request-promise');

const { ShipmentsController } = require('../shipments/shipments.controller');
const { ReturnsModel } = require('./returns.model');

exports.ReturnsController = new class ReturnsController {
  constructor() {
    this.Return = new Parse.Object.extend('Return');
  }

  getReturnsWithInformation() {
    return ReturnsModel.getReturnsByFilters({
      includes: ['order', 'orderProduct', 'customer', 'product', 'product.classification', 'productVariant', 'orderShipment'],
      limit: 1000
    }).find()
      .then(returnsObjects => returnsObjects.map(returnObject => this.minifyReturnForFrontEnd(returnObject)));
  }

  createOrderProductReturn({ order, orderProduct, customer, product, productVariant, orderShipment, options, returnTypeId }) {
    if ((typeof order === 'undefined' || order === null) 
        || (typeof orderProduct === 'undefined' || orderProduct === null)
        || (typeof customer === 'undefined' || customer === null)
        || (typeof product === 'undefined' || product === null)
        || (typeof productVariant === 'undefined' || productVariant === null)
        || (typeof orderShipment === 'undefined' || orderShipment === null)
        || (typeof options === 'undefined' || options === null)
        || (typeof returnTypeId === 'undefined' || returnTypeId === null)) {
      return Promise.reject('missing parameters');
    }

    const createNewReturn = ({ object_id, rate, tracking_number, tracking_url_provider, label_url, parcel }) => {
      const newReturn = new this.Return();
      return newReturn
        .set('checkedInAt', null)
        .set('orderId', order.get('orderId'))
        .set('order', order)
        .set('orderProductId', orderProduct.get('orderProductId'))
        .set('orderProduct', orderProduct)
        .set('customerId', customer.get('customerId'))
        .set('customer', customer)
        .set('productId', product.get('productId'))
        .set('product', product)
        .set('productVariantId', productVariant.get('variantId'))
        .set('productVariant', productVariant)
        .set('returnStatusId', 0)
        .set('returnStatus', this.returnStatuses(0))
        .set('returnTypeId', returnTypeId)
        .set('returnType', this.returnTypes(returnTypeId))
        .set('returnOptions', options)
        .set('orderShipmentId', orderShipment.get('shipmentId'))
        .set('orderShipment', orderShipment)
        .set('requestReturnEmailSended', false)
        .set('checkedInEmailSended', false)
        .set('shippoReturnData', { object_id, rate, tracking_number, tracking_url_provider, label_url, parcel })
        .save();
    }

    const addReturnToOrderProduct = (returnObject, orderProduct) => {
      const returns = orderProduct.get('returns') ? orderProduct.get('returns') : [];
      return orderProduct.set('returns', [
        ...returns,
        returnObject
      ]).save()
        .then(updatedOrderProduct => ({
          returnObject,
          orderProduct: updatedOrderProduct
        }));
    }
    
    // return createNewReturn({})
    return this.createReturnLabel(order, orderShipment)
      .then(createNewReturn)
      .then(returnObject => addReturnToOrderProduct(returnObject, orderProduct));

  }

  createReturnLabel(order, orderShipment) {
    const shippedWithShippo = typeof orderShipment.get('shippo_object_id') !== undefined;
    const address_from = ShipmentsController.baseAddress;
    const address_to = ShipmentsController.shippoShipmentAddressFromOrder(order);
    const defaultParcel = ShipmentsController.defaultUPSSmallBox;

    return shippo.transaction.create({
      shipment: {
        "object_purpose": "PURCHASE",
        "address_from": { 
          ...(shippedWithShippo ? address_from : address_to),
          object_purpose: "PURCHASE" 
        },
        "address_to": {
          ...(shippedWithShippo ? address_to : address_from),
          object_purpose: "PURCHASE"
        },
        "parcel": defaultParcel,
        "extra": { "is_return": true },
        "return_of": orderShipment.get('shippo_object_id'),
      },
      "carrier_account": "c67f85102205443e813814c72f2d48c6",
      "servicelevel_token": "usps_priority",
      "async": false,
    });
  }

  checkInReturnedProduct(returnId) {
    const returnObject = returnId => ReturnsModel.getReturnsByFilters({
      includes: ['order', 'orderProduct', 'customer', 'product', 'product.classification', 'productVariant', 'orderShipment'],
      equal: [{ key: 'objectId', value: returnId }]
    }).first();

    const isChecked = returnObject => {
      if (returnObject.get('checkedInAt') === null)
        return returnObject;
      else
        throw { success: false, message: 'Return already checked in' };
    }
    
    const setReturnAsCheckedIn = returnObject => {
      const returnTypeId = returnObject.get('returnTypeId');
      const newReturnStatusId = returnTypeId === 1 ? 1 : 2;
      return returnObject
        .set('checkedInAt', new Date())
        .set('returnStatusId', newReturnStatusId)
        .set('returnStatus', this.returnStatuses(newReturnStatusId))
        .save();
    }

    return returnObject(returnId)
      .then(isChecked)
      .then(setReturnAsCheckedIn)
      .then(this.minifyReturnForFrontEnd);
  }

  updateReturnStatus(returnId, returnStatusId) {
    const returnObject = returnId => ReturnsModel.getReturnsByFilters({
      includes: ['order', 'orderProduct', 'customer', 'product', 'product.classification', 'productVariant', 'orderShipment'],
      equal: [{ key: 'objectId', value: returnId }]
    }).first();

    const updateReturnStatus = returnObject => {
      return returnObject
        .set('returnStatusId', returnStatusId)
        .set('returnStatus', this.returnStatuses(returnStatusId))
        .save();
    }

    return returnObject(returnId)
      .then(updateReturnStatus)
      .then(this.minifyReturnForFrontEnd);
  }

  returnsForEmails() {
    const toRequestReturns = ReturnsModel.getReturnsByFilters({
      equal: [
        { key: 'returnStatusId', value: 0 },
        { key: 'requestReturnEmailSended', value: false },
        { key: 'checkedInEmailSended', value: false },
        { key: 'checkedInAt', value: null }
      ]
    });
    
    const checkedInReturnsEmails = ReturnsModel.getReturnsByFilters({
      equal: [
        { key: 'checkedInEmailSended', value: false },
      ],
      notEqual: [
        { key: 'returnTypeId', value: 0 },
        { key: 'returnStatusId', value: 0 },
        { key: 'checkedInAt', value: null }
      ]
    })

    return Parse.Query.or(toRequestReturns, checkedInReturnsEmails)
      .include('order')
      .include('orderProduct')
      .include('customer')
      .include('product')
      .include('product.classification')
      .include('productVariant')
      .include('orderShipment')
      .find()
      .then(returnsObjects => returnsObjects.map(ro => this.minifyReturnForFrontEnd(ro)));
  }

  sendReturnEmail(returnId, emailSubject, emailText) {
    const returnObject = returnId => ReturnsModel.getReturnsByFilters({
      includes: ['order', 'orderProduct', 'customer', 'product', 'product.classification', 'productVariant', 'orderShipment'],
      equal: [{ key: 'objectId', value: returnId }]
    }).first();

    const updateReturnObject = returnObject => {
      if (returnObject.get('returnStatusId') === 0)
        returnObject.set('requestReturnEmailSended', true);
      else if (returnObject.get('requestReturnEmailSended') && returnObject.get('returnStatusId') !== 0)
        returnObject.set('checkedInEmailSended', true);
      else 
        return Promise.reject(`There is a problem sending the email about the return #${returnObject.id}`)

      return returnObject.save();
    }

    const sendEmail = returnObject => {
      if (typeof returnObject.get('shippoReturnData').label_url === 'undefined')
        return Promise.reject(`This shipment wasn't made with Shippo so is not possible to make the automatic return with it.`);

        return request
        .defaults({ encoding: null })
        .get(returnObject.get('shippoReturnData').label_url)
        .then(label => {
          const attch = new mailgun.Attachment({ 
            data: label, 
            filename: 'label.pdf',
            contentType: 'application/pdf'
          });

          return {
            from: 'tracy@loveaudryrose.com',
            to: `${returnObject.get('order').get('customer').get('firstName') + ' ' + returnObject.get('order').get('customer').get('lastName')} <${process.env.NODE_ENV === 'production' ? returnObject.get('order').get('billing_address').email : 'ejas94@gmail.com'}>`,
            cc: process.env.NODE_ENV === 'production' ? 'Audry Rose <tracy@loveaudryrose.com>' : 'Testing <arrieta.e@outlook.com>',
            subject: emailSubject,
            text: emailText,
            attachment: !returnObject.get('requestReturnEmailSended') ? attch : null
          }
        })
        .then(message => mailgun.messages().send(message))
        .then(emailResult => returnObject);
    }

    return returnObject(returnId)
      .then(returnObject => sendEmail(returnObject))
      .then(updateReturnObject)
      .then(this.minifyReturnForFrontEnd);
  }

  /** ------------------------------------------- */
  /** ------------- Extra Functions ------------- */
  /** ------------------------------------------- */

  minifyReturnForFrontEnd(returnObject) {
    const order = returnObject.get('order');
    const product = returnObject.get('product');
    const classification = product.get('classification');
    const customer = returnObject.get('customer');
    return {
      id: returnObject.id,
      dateRequested: moment(returnObject.get('createdAt')).toISOString(),
      dateCheckedIn: returnObject.get('checkedInAt') ? moment(returnObject.get('checkedInAt')).toISOString() : null,
      orderId: returnObject.get('orderId'),
      customerName: customer.get('firstName') + ' ' + customer.get('lastName'),
      customerLifetime: {
        totalSpend: customer.get('totalSpend'),
        totalOrders: customer.get('totalOrders'),
      },
      productName: product.get('name'),
      productImage: product.get('primary_image') ? product.get('primary_image').thumbnail_url : null,
      productClassification: classification ? classification.get('name') : null,
      returnOptions: returnObject.get('returnOptions'),
      orderNotes: {
        staffNotes: order.get('staff_notes') ? order.get('staff_notes') : null,
        internalNotes: order.get('internalNotes') ? order.get('internalNotes') : null,
        designerNotes: order.get('designerNotes') ? order.get('designerNotes') : null,
        customerNotes: order.get('customer_message') ? order.get('customer_message') : null,
      },
      returnStatus: returnObject.get('returnStatus'),
      returnStatusId: returnObject.get('returnStatusId'),
      returnType: returnObject.get('returnType'),
      returnTypeId: returnObject.get('returnTypeId'),
    }
  }

  returnTypes(index) {
    const returnTypes = ['return', 'repair', 'resize'];
    return typeof index !== 'undefined' ? returnTypes[index] : returnTypes;
  }

  returnStatuses(index) {
    const returnStatuses = ['requested', 'being repaired', 'being resized', 'resize completed', 'repair completed', 'ready to ship'];
    return typeof index !== 'undefined' ? returnStatuses[index] : returnStatuses;
  }  

}