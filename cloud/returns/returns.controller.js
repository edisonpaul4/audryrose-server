var path = require('path');
var fs = require('fs');
var streams = require('memory-streams');
var moment = require('moment');

const { ReturnsModel } = require('./returns.model');

exports.ReturnsController = new class ReturnsController {
  constructor() {
    this.Return = new Parse.Object.extend('Return');
  }

  createOrderProductReturn(params) {
    const { order, orderProduct, customer, product, productVariant, returnReasonId } = params;
    if ((typeof order === 'undefined' || order === null) 
        || (typeof orderProduct === 'undefined' || orderProduct === null)
        || (typeof customer === 'undefined' || customer === null)
        || (typeof product === 'undefined' || product === null)
        || (typeof productVariant === 'undefined' || productVariant === null)
        || (typeof returnReasonId === 'undefined' || returnReasonId === null)) {
      return Promise.reject().then(() => 'missing parameters');
    }

    const addReturnToOrderPRoduct = (returnObject, orderProduct) => {
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
    
    const newReturn = new this.Return();
    newReturn
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
      .set('returnReasonId', returnReasonId)
      .set('returnReason', this.returnReasons(returnReasonId))

    return newReturn.save()
      .then(returnObject => addReturnToOrderPRoduct(returnObject, orderProduct));

  }

  returnReasons(index) {
    const returnReasons = ['resize', 'repair', 'refund'];
    return typeof index !== 'undefined' ? returnReasons[index] : returnReasons;
  }

  returnStatuses(index) {
    const returnStatuses = ['requested', 'being repaired', 'being resized', 'resize completed', 'repair completed'];
    return typeof index !== 'undefined' ? returnStatuses[index] : returnStatuses;
  }  

}